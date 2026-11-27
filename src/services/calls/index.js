import { query, tx, pool } from '../../db/pool.js';
import { config } from '../../config.js';
import { conflict, notFound, badRequest } from '../../lib/errors.js';
import { settingsOf, getTenant } from '../tenants.js';
import { audience, audiencePreview } from '../segments.js';
import { progressFor, progressLine } from '../schemes.js';
import * as ledger from '../ledger.js';
import { emit } from '../events.js';
import { buildScript } from './scripts.js';
import { getCallProvider } from './providers.js';
import { hasWayneRing } from '../bundle.js';

export const OUTCOMES = ['INTERESTED', 'NOT_INTERESTED', 'NO_ANSWER', 'WRONG_NUMBER', 'CALL_LATER', 'DO_NOT_CALL'];

const istHour = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600e3).getUTCHours();

// Testing report 2 #4: was "Flow Test Scheme — 0, agle slab ke liye 1 aur" (no unit, no reward).
function schemeLine(schemes, lang) {
  const s = schemes.find((x) => x.type !== 'SCAN_MULTIPLIER' && x.progress) || schemes[0];
  if (!s) return lang === 'en' ? 'no live scheme right now' : 'abhi koi scheme live nahi';
  return progressLine(s, lang);
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
        `SELECT 1 FROM calls WHERE participant_id=$1 AND status NOT IN ('SKIPPED','TEST','FAILED') AND created_at > now() - make_interval(days => $2) LIMIT 1`, [p.id, s.callCooldownDays]);
      if (recent) { cooldown++; continue; }
      const w = await ledger.getWallet(db, p.id);
      const schemes = await progressFor({ tenant, participant: p });
      const vars = { name: p.name || '', brand: tenant.name, balance: w.balance.toLocaleString('en-IN'), scheme: schemeLine(schemes, c.language), city: p.city || '' };
      vars.scheme_progress = vars.scheme; // testing report 3 #7: same variable names as WhatsApp campaigns
      await db.query(`INSERT INTO calls (tenant_id, campaign_id, participant_id, context) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [tenantId, c.id, p.id, { vars, ...buildScript({ script: c.script, language: c.language, vars }) }]);
      queued++;
    }
    // Testing report #4: 0 calls is not "COMPLETED". Say why and keep it out of the finished list.
    if (!queued) {
      const why = !people.length
        ? (await audiencePreview(db, { tenantId, segments: c.segments, types: c.participant_types, city: c.city, schemeId: c.scheme_id })).reasons.join(' ')
        : `Everyone matched was skipped: ${dnd} on DND, ${cooldown} already called in the last ${s.callCooldownDays} days.`;
      const { rows: [u] } = await db.query(`UPDATE call_campaigns SET status='CANCELLED', note=$2, launched_at=now() WHERE id=$1 RETURNING *`, [c.id, `Not started — ${why}`]);
      return { campaign: u, queued, matched: people.length, skipped: { dnd, cooldown }, reason: why };
    }
    const h = istHour();
    const note = h < s.callHoursStart || h >= s.callHoursEnd ? `Queued — calls start at ${s.callHoursStart}:00 IST (calling hours ${s.callHoursStart}:00–${s.callHoursEnd}:00).` : null;
    const { rows: [u] } = await db.query(`UPDATE call_campaigns SET status='RUNNING', note=$2, launched_at=now() WHERE id=$1 RETURNING *`, [c.id, note]);
    return { campaign: u, queued, matched: people.length, skipped: { dnd, cooldown }, note };
  });
}

/** Worker: place queued calls, only inside each brand's calling hours. */
export async function dispatchDue({ limit = 20, now = new Date() } = {}) {
  const client = await pool.connect();
  let n = 0;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT k.*, p.mobile, c.language, c.provider, t.settings AS tenant_settings, t.hub_business_id
        FROM calls k JOIN call_campaigns c ON c.id=k.campaign_id JOIN participants p ON p.id=k.participant_id JOIN tenants t ON t.id=k.tenant_id
       WHERE k.status='QUEUED' AND c.status='RUNNING' ORDER BY k.created_at LIMIT $1 FOR UPDATE OF k SKIP LOCKED`, [limit]);
    const results = [];
    for (const k of rows) {
      const s = settingsOf({ settings: k.tenant_settings });
      if (!hasWayneRing({ hub_business_id: k.hub_business_id, settings: k.tenant_settings })) { // bundle rule: WayneRing only
        await client.query(`UPDATE calls SET status='SKIPPED', summary='WayneRing is not in the package', completed_at=now() WHERE id=$1`, [k.id]);
        continue;
      }
      const h = istHour(now);
      if (h < s.callHoursStart || h >= s.callHoursEnd) { // outside calling hours: stays queued, but say so
        await client.query(`UPDATE calls SET summary=$2 WHERE id=$1 AND summary IS DISTINCT FROM $2`, [k.id, `Waiting for calling hours (${s.callHoursStart}:00–${s.callHoursEnd}:00 IST)`]);
        continue;
      }
      try {
        const out = await getCallProvider(k.provider).startCall({ callId: k.id, to: k.mobile, language: k.language, firstMessage: k.context.firstMessage, instructions: k.context.instructions, variables: k.context.vars });
        await client.query(`UPDATE calls SET status='DIALING', provider_call_id=$2, attempted_at=now(), summary=$3, test_mode=$4, provider_status=$5 WHERE id=$1`,
          [k.id, out.providerCallId, k.provider === 'mock' ? 'TEST MODE — WayneRing was not called (CALL_PROVIDER=mock)' : `Sent to WayneRing (call ID ${out.providerCallId}) — waiting for the result`, k.provider === 'mock', out.providerStatus || null]);
        if (out.result) results.push({ callId: k.id, ...out.result });
      } catch (e) {
        // Testing report 3 #1: a call WayneRing never placed is FAILED – not dialled, with the reason.
        await client.query(`UPDATE calls SET status='FAILED', dial_failed=true, summary=$2, provider_call_id=coalesce($3, provider_call_id), provider_status=$4, attempted_at=now(), completed_at=now() WHERE id=$1`,
          [k.id, `FAILED – not dialled: ${e.message.replace(/^not dialled — /, '')}`.slice(0, 300), e.providerCallId || null, e.providerStatus || 'start-error']);
      }
      n++;
    }
    await client.query('COMMIT');
    for (const r of results) await settleCall(r);
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
  await expireSilentCalls({ now });
  await completeFinishedCampaigns();
  return n;
}

/**
 * Outcome from provider (sync or webhook). Idempotent. Calls never change points.
 * Testing report 3 #1: `notDialled` (WayneRing never rang the phone) → FAILED – not dialled + reason,
 * never NO_ANSWER. Testing report 3 #6: a test call is status TEST, never COMPLETED.
 */
export async function settleCall({ callId, providerCallId, outcome, summary, failed, notDialled, reason, providerStatus, raw, testMode }) {
  return tx(async (db) => {
    const { rows: [k] } = await db.query(
      `SELECT * FROM calls WHERE ${callId ? 'id=$1' : 'provider_call_id=$1'} FOR UPDATE`, [callId || providerCallId]);
    if (!k) throw notFound('Call');
    if (['COMPLETED', 'FAILED', 'TEST'].includes(k.status)) return k;
    if (testMode || k.test_mode) {
      const { rows: [u] } = await db.query(`UPDATE calls SET status='TEST', outcome=$3, summary=$2, test_mode=true, completed_at=now() WHERE id=$1 RETURNING *`,
        [k.id, summary || 'TEST MODE — no real call was placed', OUTCOMES.includes(outcome) ? outcome : null]);
      return u;
    }
    if (failed) {
      const why = notDialled ? `FAILED – not dialled: ${reason || 'WayneRing did not place the call'}` : `FAILED: ${reason || 'WayneRing reported a failure'}`;
      const { rows: [u] } = await db.query(
        `UPDATE calls SET status='FAILED', outcome=NULL, dial_failed=$3, summary=$2, provider_status=coalesce($4, provider_status), provider_detail=coalesce($5, provider_detail), completed_at=now() WHERE id=$1 RETURNING *`,
        [k.id, `${why}${summary ? ` · WayneRing: ${summary}` : ''}`.slice(0, 500), !!notDialled, providerStatus || null, raw || null]);
      return u;
    }
    const oc = OUTCOMES.includes(outcome) ? outcome : 'NO_ANSWER';
    const { rows: [u] } = await db.query(
      `UPDATE calls SET status='COMPLETED', outcome=$2, summary=$3, provider_status=coalesce($4, provider_status), provider_detail=coalesce($5, provider_detail), completed_at=now() WHERE id=$1 RETURNING *`,
      [k.id, oc, summary || null, providerStatus || null, raw || null]);
    if (oc === 'DO_NOT_CALL') await db.query(`UPDATE participants SET dnd=true WHERE id=$1`, [k.participant_id]);
    await emit(db, k.tenant_id, 'call.completed', { callId: k.id, campaignId: k.campaign_id, participantId: k.participant_id, outcome: oc });
    return u;
  });
}

/**
 * Testing report 3 #1: WayneRing took the call but never reported back → it was most likely never
 * dialled. After CALL_RESULT_TIMEOUT_MIN (default 20) a DIALING call becomes FAILED – not dialled.
 */
export async function expireSilentCalls({ now = new Date() } = {}) {
  const mins = Number(process.env.CALL_RESULT_TIMEOUT_MIN || 20);
  await query(`UPDATE calls SET status='FAILED', dial_failed=true, completed_at=now(),
                      summary='FAILED – not dialled: WayneRing sent no result within ' || $2::int || ' minutes' || coalesce(' (WayneRing call ID ' || provider_call_id || ')', '')
                WHERE status='DIALING' AND NOT test_mode AND attempted_at < $1::timestamptz - make_interval(mins => $2::int)`, [now, mins]);
}

// Testing report 2 #5: if every call failed the campaign is FAILED (with the first reason), not COMPLETED.
// Testing report 3 #6: if every call was a test call, the campaign is TEST, not COMPLETED.
export async function completeFinishedCampaigns() {
  await query(`UPDATE call_campaigns c SET
                  status = CASE WHEN NOT EXISTS (SELECT 1 FROM calls k WHERE k.campaign_id=c.id AND k.status IN ('COMPLETED','FAILED'))
                                 AND EXISTS (SELECT 1 FROM calls k WHERE k.campaign_id=c.id AND k.status='TEST') THEN 'TEST'
                                WHEN EXISTS (SELECT 1 FROM calls k WHERE k.campaign_id=c.id AND k.status='FAILED')
                                 AND NOT EXISTS (SELECT 1 FROM calls k WHERE k.campaign_id=c.id AND k.status='COMPLETED') THEN 'FAILED' ELSE 'COMPLETED' END,
                  note = CASE WHEN NOT EXISTS (SELECT 1 FROM calls k WHERE k.campaign_id=c.id AND k.status IN ('COMPLETED','FAILED'))
                                 AND EXISTS (SELECT 1 FROM calls k WHERE k.campaign_id=c.id AND k.status='TEST') THEN 'TEST MODE — no real calls were placed (CALL_PROVIDER=mock)'
                              WHEN EXISTS (SELECT 1 FROM calls k WHERE k.campaign_id=c.id AND k.status='FAILED')
                                 AND NOT EXISTS (SELECT 1 FROM calls k WHERE k.campaign_id=c.id AND k.status='COMPLETED')
                              THEN 'All calls failed: ' || coalesce((SELECT k.summary FROM calls k WHERE k.campaign_id=c.id AND k.status='FAILED' AND k.summary IS NOT NULL LIMIT 1), 'see the calls list')
                              ELSE c.note END,
                  completed_at=now()
                WHERE status='RUNNING' AND NOT EXISTS (SELECT 1 FROM calls k WHERE k.campaign_id=c.id AND k.status IN ('QUEUED','DIALING'))`);
}

export async function campaignStats(campaignId) {
  const { rows } = await query(`SELECT status, outcome, test_mode, dial_failed, count(*)::int AS n FROM calls WHERE campaign_id=$1 GROUP BY 1,2,3,4`, [campaignId]);
  const s = { total: 0, queued: 0, dialing: 0, completed: 0, failed: 0, notDialled: 0, test: 0, outcomes: {} };
  for (const r of rows) {
    s.total += r.n; s[r.status.toLowerCase()] = (s[r.status.toLowerCase()] || 0) + r.n;
    if (r.dial_failed) s.notDialled += r.n;
    if (r.outcome) s.outcomes[r.outcome] = (s.outcomes[r.outcome] || 0) + r.n;
  }
  return s;
}
