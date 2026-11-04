import { query, tx, pool } from '../../db/pool.js';
import { config } from '../../config.js';
import { conflict, notFound } from '../../lib/errors.js';
import { settingsOf, getTenant } from '../tenants.js';
import { audience } from '../segments.js';
import { progressFor } from '../schemes.js';
import * as ledger from '../ledger.js';
import { emit } from '../events.js';
import { buildScript } from './scripts.js';
import { getCallProvider } from './providers.js';

export const OUTCOMES = ['INTERESTED', 'NOT_INTERESTED', 'NO_ANSWER', 'WRONG_NUMBER', 'CALL_LATER', 'DO_NOT_CALL'];

const istHour = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600e3).getUTCHours();

function schemeLine(schemes, lang) {
  const s = schemes.find((x) => x.type !== 'SCAN_MULTIPLIER' && x.progress) || schemes[0];
  if (!s) return lang === 'en' ? 'no live scheme right now' : 'abhi koi scheme live nahi';
  if (s.type === 'SCAN_MULTIPLIER') return `${s.name}: ${s.multiplier}x points`;
  const p = s.progress; const unit = s.metric === 'AMOUNT' ? '₹' : '';
  const next = p.nextSlab ? (lang === 'en' ? `, ${unit}${p.remainingToNext.toLocaleString('en-IN')} more to the next slab` : `, agle slab ke liye ${unit}${p.remainingToNext.toLocaleString('en-IN')} aur`) : '';
  return `${s.name} — ${unit}${p.value.toLocaleString('en-IN')}${next}`;
}

export async function createCampaign({ tenantId, adminId, body }) {
  const { rows: [c] } = await query(
    `INSERT INTO call_campaigns (tenant_id, name, script, language, segments, participant_types, city, scheme_id, provider, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [tenantId, body.name, body.script, body.language || 'hi', body.segments || [], body.participantTypes || [], body.city || null, body.schemeId || null, config.calls.provider, adminId]);
  return c;
}

/** Freeze the audience into a call list. DND and recently-called people are skipped. */
export async function launchCampaign({ tenantId, campaignId }) {
  const tenant = await getTenant(tenantId);
  const s = settingsOf(tenant);
  return tx(async (db) => {
    const { rows: [c] } = await db.query(`SELECT * FROM call_campaigns WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [campaignId, tenantId]);
    if (!c) throw notFound('Call campaign');
    if (c.status !== 'DRAFT') throw conflict('INVALID_STATE', `Campaign is ${c.status}`);
    const people = await audience(db, { tenantId, segments: c.segments, types: c.participant_types, city: c.city, schemeId: c.scheme_id });
    let queued = 0, dnd = 0, cooldown = 0;
    for (const p of people) {
      if (p.dnd) { dnd++; continue; }
      const { rows: [recent] } = await db.query(
        `SELECT 1 FROM calls WHERE participant_id=$1 AND status <> 'SKIPPED' AND created_at > now() - make_interval(days => $2) LIMIT 1`, [p.id, s.callCooldownDays]);
      if (recent) { cooldown++; continue; }
      const w = await ledger.getWallet(db, p.id);
      const schemes = await progressFor({ tenant, participant: p });
      const vars = { name: p.name || '', brand: tenant.name, balance: w.balance.toLocaleString('en-IN'), scheme: schemeLine(schemes, c.language), city: p.city || '' };
      await db.query(`INSERT INTO calls (tenant_id, campaign_id, participant_id, context) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [tenantId, c.id, p.id, { vars, ...buildScript({ script: c.script, language: c.language, vars }) }]);
      queued++;
    }
    const status = queued ? 'RUNNING' : 'COMPLETED';
    const { rows: [u] } = await db.query(`UPDATE call_campaigns SET status=$2, launched_at=now(), completed_at=CASE WHEN $2='COMPLETED' THEN now() END WHERE id=$1 RETURNING *`, [c.id, status]);
    return { campaign: u, queued, skipped: { dnd, cooldown } };
  });
}

/** Worker: place queued calls, only inside each brand's calling hours. */
export async function dispatchDue({ limit = 20, now = new Date() } = {}) {
  const client = await pool.connect();
  let n = 0;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT k.*, p.mobile, c.language, c.provider, t.settings AS tenant_settings
        FROM calls k JOIN call_campaigns c ON c.id=k.campaign_id JOIN participants p ON p.id=k.participant_id JOIN tenants t ON t.id=k.tenant_id
       WHERE k.status='QUEUED' AND c.status='RUNNING' ORDER BY k.created_at LIMIT $1 FOR UPDATE OF k SKIP LOCKED`, [limit]);
    const results = [];
    for (const k of rows) {
      const s = settingsOf({ settings: k.tenant_settings });
      const h = istHour(now);
      if (h < s.callHoursStart || h >= s.callHoursEnd) continue; // outside calling hours: stays queued
      try {
        const out = await getCallProvider(k.provider).startCall({ callId: k.id, to: k.mobile, language: k.language, firstMessage: k.context.firstMessage, instructions: k.context.instructions, variables: k.context.vars });
        await client.query(`UPDATE calls SET status='DIALING', provider_call_id=$2, attempted_at=now() WHERE id=$1`, [k.id, out.providerCallId]);
        if (out.result) results.push({ callId: k.id, ...out.result });
      } catch (e) {
        await client.query(`UPDATE calls SET status='FAILED', summary=$2, attempted_at=now(), completed_at=now() WHERE id=$1`, [k.id, e.message.slice(0, 300)]);
      }
      n++;
    }
    await client.query('COMMIT');
    for (const r of results) await settleCall(r);
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
  await completeFinishedCampaigns();
  return n;
}

/** Outcome from provider (sync or webhook). Idempotent. Calls never change points. */
export async function settleCall({ callId, providerCallId, outcome, summary, failed }) {
  return tx(async (db) => {
    const { rows: [k] } = await db.query(
      `SELECT * FROM calls WHERE ${callId ? 'id=$1' : 'provider_call_id=$1'} FOR UPDATE`, [callId || providerCallId]);
    if (!k) throw notFound('Call');
    if (['COMPLETED', 'FAILED'].includes(k.status)) return k;
    const oc = OUTCOMES.includes(outcome) ? outcome : 'NO_ANSWER';
    const { rows: [u] } = await db.query(
      `UPDATE calls SET status=$2, outcome=$3, summary=$4, completed_at=now() WHERE id=$1 RETURNING *`, [k.id, failed ? 'FAILED' : 'COMPLETED', failed ? null : oc, summary || null]);
    if (oc === 'DO_NOT_CALL') await db.query(`UPDATE participants SET dnd=true WHERE id=$1`, [k.participant_id]);
    await emit(db, k.tenant_id, 'call.completed', { callId: k.id, campaignId: k.campaign_id, participantId: k.participant_id, outcome: oc });
    return u;
  });
}

export async function completeFinishedCampaigns() {
  await query(`UPDATE call_campaigns c SET status='COMPLETED', completed_at=now()
                WHERE status='RUNNING' AND NOT EXISTS (SELECT 1 FROM calls k WHERE k.campaign_id=c.id AND k.status IN ('QUEUED','DIALING'))`);
}

export async function campaignStats(campaignId) {
  const { rows } = await query(`SELECT status, outcome, count(*)::int AS n FROM calls WHERE campaign_id=$1 GROUP BY 1,2`, [campaignId]);
  const s = { total: 0, queued: 0, dialing: 0, completed: 0, failed: 0, outcomes: {} };
  for (const r of rows) {
    s.total += r.n; s[r.status.toLowerCase()] = (s[r.status.toLowerCase()] || 0) + r.n;
    if (r.outcome) s.outcomes[r.outcome] = (s.outcomes[r.outcome] || 0) + r.n;
  }
  return s;
}
