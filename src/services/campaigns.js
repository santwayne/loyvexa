import { query, tx } from '../db/pool.js';
import { conflict, notFound } from '../lib/errors.js';
import { settingsOf } from './tenants.js';
import { audience } from './segments.js';
import { progressFor, progressLine } from './schemes.js';
import { sendTemplate } from './whatsapp.js';
import { appLink } from './bot.js';
import * as ledger from './ledger.js';

/**
 * WhatsApp broadcast campaigns. Always an approved template (business-initiated).
 * Opted-out participants (sent STOP) are never included. Sends are rate-limited per worker tick
 * and capped per brand per day.
 * params: strings with placeholders {name} {brand} {balance} {scheme_progress} {app_link}
 */
export async function createWaCampaign({ tenantId, adminId, body }) {
  const { rows: [c] } = await query(
    `INSERT INTO wa_campaigns (tenant_id, name, template_name, language, params, preview_text, segments, participant_types, scheme_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [tenantId, body.name, body.templateName, body.language || 'en', JSON.stringify(body.params || []), body.previewText || null,
      body.segments || [], body.participantTypes || [], body.schemeId || null, adminId]);
  return c;
}

export async function launchWaCampaign({ tenantId, campaignId }) {
  return tx(async (db) => {
    const { rows: [c] } = await db.query(`SELECT * FROM wa_campaigns WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [campaignId, tenantId]);
    if (!c) throw notFound('Campaign');
    if (c.status !== 'DRAFT') throw conflict('INVALID_STATE', `Campaign is ${c.status}`);
    const people = await audience(db, { tenantId, segments: c.segments, types: c.participant_types, schemeId: c.scheme_id });
    let queued = 0, optedOut = 0;
    for (const p of people) {
      if (p.wa_opt_out) { optedOut++; continue; }
      await db.query(`INSERT INTO wa_campaign_recipients (campaign_id, participant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [c.id, p.id]);
      queued++;
    }
    // Nobody to send to is not "COMPLETED": say why.
    const note = queued ? null : `Not started — ${people.length ? `all ${people.length} matched people sent STOP` : 'nobody matches these filters'}`;
    const { rows: [u] } = await db.query(`UPDATE wa_campaigns SET status=$2, note=$3, launched_at=now() WHERE id=$1 RETURNING *`, [c.id, queued ? 'RUNNING' : 'CANCELLED', note]);
    return { campaign: u, queued, skipped: { optedOut } };
  });
}

const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (_, k) => (v[k] ?? ''));

async function varsFor(tenant, p) {
  const w = await ledger.getWallet({ query }, p.id);
  const schemes = await progressFor({ tenant, participant: p });
  const s = schemes.find((x) => x.progress);
  const scheme_progress = s ? progressLine(s, p.language === 'en' ? 'en' : 'hi') : '';
  return { name: p.name || '', brand: tenant.name, balance: w.balance.toLocaleString('en-IN'), scheme_progress, app_link: appLink(tenant) };
}

/** Worker: send queued campaign messages within per-tick and per-day limits. */
export async function sendDue() {
  const { rows: running } = await query(`SELECT c.*, row_to_json(t.*) AS tenant FROM wa_campaigns c JOIN tenants t ON t.id=c.tenant_id WHERE c.status='RUNNING' ORDER BY c.launched_at`);
  let sent = 0;
  for (const c of running) {
    const s = settingsOf(c.tenant);
    const { rows: [today] } = await query(`
      SELECT count(*)::int AS n FROM wa_campaign_recipients r JOIN wa_campaigns w ON w.id=r.campaign_id
       WHERE w.tenant_id=$1 AND r.status <> 'QUEUED' AND r.status <> 'SKIPPED' AND r.updated_at > date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`, [c.tenant_id]);
    const room = Math.min(s.waCampaignPerTick, s.waCampaignDailyCap - today.n);
    if (room <= 0) continue;
    const { rows: batch } = await query(`
      SELECT p.* FROM wa_campaign_recipients r JOIN participants p ON p.id=r.participant_id
       WHERE r.campaign_id=$1 AND r.status='QUEUED' ORDER BY p.created_at LIMIT $2`, [c.id, room]);
    for (const p of batch) {
      if (p.wa_opt_out || p.status !== 'ACTIVE') { await query(`UPDATE wa_campaign_recipients SET status='SKIPPED', updated_at=now() WHERE campaign_id=$1 AND participant_id=$2`, [c.id, p.id]); continue; }
      const v = await varsFor(c.tenant, p);
      const m = await sendTemplate({ tenantId: c.tenant_id, participantId: p.id, to: p.mobile, name: c.template_name, language: c.language, params: (c.params || []).map((x) => fill(x, v)), previewText: c.preview_text ? fill(c.preview_text, v) : null });
      await query(`UPDATE wa_campaign_recipients SET status=$3, message_id=$4, error=$5, updated_at=now() WHERE campaign_id=$1 AND participant_id=$2`,
        [c.id, p.id, m.status === 'FAILED' ? 'FAILED' : 'SENT', m.id, m.status === 'FAILED' ? m.error : null]);
      sent++;
    }
    await finishCampaign(c.id);
  }
  return sent;
}

/**
 * Testing report 2 #5: "3 Failed, 0 Sent" was shown as COMPLETED. When nothing is left in the
 * queue: nobody reached → FAILED (with the most common reason); some failed → COMPLETED with a note.
 * Also re-run when a delivery receipt turns a SENT message into FAILED.
 */
export async function finishCampaign(campaignId) {
  const { rows: [c] } = await query(`SELECT id, status FROM wa_campaigns WHERE id=$1`, [campaignId]);
  if (!c || !['RUNNING', 'COMPLETED', 'FAILED'].includes(c.status)) return;
  const { rows } = await query(`SELECT status, count(*)::int AS n FROM wa_campaign_recipients WHERE campaign_id=$1 GROUP BY 1`, [campaignId]);
  const st = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  if (st.QUEUED) return;
  const ok = (st.SENT || 0) + (st.DELIVERED || 0) + (st.READ || 0);
  const failed = st.FAILED || 0;
  const { rows: [top] } = failed ? await query(`SELECT error, count(*)::int AS n FROM wa_campaign_recipients WHERE campaign_id=$1 AND status='FAILED' GROUP BY 1 ORDER BY 2 DESC LIMIT 1`, [campaignId]) : { rows: [] };
  const reason = top?.error || 'no reason given';
  const status = failed && !ok ? 'FAILED' : 'COMPLETED';
  const note = !failed ? null : !ok ? `All ${failed} messages failed — ${reason}` : `${failed} of ${failed + ok} failed — most common reason: ${reason}`;
  await query(`UPDATE wa_campaigns SET status=$2, note=$3, completed_at=coalesce(completed_at, now()) WHERE id=$1`, [campaignId, status, note]);
}

/** WhatsApp delivery receipts (sent / delivered / read / failed). */
export async function applyStatus({ providerMsgId, status, error }) {
  const map = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' };
  const st = map[status];
  if (!st) return;
  const { rows: [m] } = await query(`UPDATE messages SET status=$2, error=coalesce($3,error) WHERE provider_msg_id=$1 AND direction='OUT' RETURNING id`, [providerMsgId, st, error || null]);
  if (m) {
    // never move a receipt backwards (read -> delivered)
    const { rows: changed } = await query(`UPDATE wa_campaign_recipients SET status=$2, error=CASE WHEN $2='FAILED' THEN coalesce($3, error) ELSE error END, updated_at=now() WHERE message_id=$1
                  AND array_position(ARRAY['QUEUED','SENT','DELIVERED','READ'], status) < coalesce(array_position(ARRAY['QUEUED','SENT','DELIVERED','READ'], $2), 99)
                  RETURNING campaign_id`, [m.id, st, error || null]);
    if (st === 'FAILED') for (const r of changed) await finishCampaign(r.campaign_id);
  }
}

export async function waCampaignStats(id) {
  const { rows } = await query(`SELECT status, count(*)::int AS n FROM wa_campaign_recipients WHERE campaign_id=$1 GROUP BY 1`, [id]);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/** Who got it, who didn't, and why (testing report 2 #5). */
export async function waCampaignRecipients(tenantId, campaignId) {
  const { rows } = await query(`
    SELECT r.status, r.error, r.updated_at, p.name, p.mobile, p.type, p.city
      FROM wa_campaign_recipients r JOIN wa_campaigns c ON c.id=r.campaign_id JOIN participants p ON p.id=r.participant_id
     WHERE r.campaign_id=$1 AND c.tenant_id=$2 ORDER BY (r.status='FAILED') DESC, p.name`, [campaignId, tenantId]);
  return rows;
}
