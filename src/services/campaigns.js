import { query, tx } from '../db/pool.js';
import { conflict, notFound } from '../lib/errors.js';
import { settingsOf } from './tenants.js';
import { audience } from './segments.js';
import { progressFor } from './schemes.js';
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
    const { rows: [u] } = await db.query(`UPDATE wa_campaigns SET status=$2, launched_at=now(), completed_at=CASE WHEN $2='COMPLETED' THEN now() END WHERE id=$1 RETURNING *`, [c.id, queued ? 'RUNNING' : 'COMPLETED']);
    return { campaign: u, queued, skipped: { optedOut } };
  });
}

const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (_, k) => (v[k] ?? ''));

async function varsFor(tenant, p) {
  const w = await ledger.getWallet({ query }, p.id);
  const schemes = await progressFor({ tenant, participant: p });
  const s = schemes.find((x) => x.progress);
  const unit = s?.metric === 'AMOUNT' ? '₹' : '';
  const scheme_progress = s ? `${s.name}: ${unit}${s.progress.value.toLocaleString('en-IN')}${s.progress.nextSlab ? `, ${unit}${s.progress.remainingToNext.toLocaleString('en-IN')} to next slab` : ''}` : '';
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
      await query(`UPDATE wa_campaign_recipients SET status=$3, message_id=$4, updated_at=now() WHERE campaign_id=$1 AND participant_id=$2`,
        [c.id, p.id, m.status === 'FAILED' ? 'FAILED' : 'SENT', m.id]);
      sent++;
    }
    await query(`UPDATE wa_campaigns w SET status='COMPLETED', completed_at=now() WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM wa_campaign_recipients r WHERE r.campaign_id=w.id AND r.status='QUEUED')`, [c.id]);
  }
  return sent;
}

/** WhatsApp delivery receipts (sent / delivered / read / failed). */
export async function applyStatus({ providerMsgId, status, error }) {
  const map = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' };
  const st = map[status];
  if (!st) return;
  const { rows: [m] } = await query(`UPDATE messages SET status=$2, error=coalesce($3,error) WHERE provider_msg_id=$1 AND direction='OUT' RETURNING id`, [providerMsgId, st, error || null]);
  if (m) {
    // never move a receipt backwards (read -> delivered)
    await query(`UPDATE wa_campaign_recipients SET status=$2, updated_at=now() WHERE message_id=$1
                  AND array_position(ARRAY['QUEUED','SENT','DELIVERED','READ'], status) < coalesce(array_position(ARRAY['QUEUED','SENT','DELIVERED','READ'], $2), 99)`, [m.id, st]);
  }
}

export async function waCampaignStats(id) {
  const { rows } = await query(`SELECT status, count(*)::int AS n FROM wa_campaign_recipients WHERE campaign_id=$1 GROUP BY 1`, [id]);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
