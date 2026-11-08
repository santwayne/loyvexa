import { query, tx } from '../../db/pool.js';
import { config } from '../../config.js';
import { createScheme } from '../schemes.js';
import { buildScript } from '../calls/scripts.js';
import * as ledger from '../ledger.js';
import { emit } from '../events.js';
import { sendBusiness } from './messaging.js';
import { CHANNEL, aiSettings, ist, withinContactHours } from './settings.js';

/**
 * Carries out approved actions. WhatsApp and calls only inside the brand's
 * contact hours (an approved action waits until then). Each action is
 * claimed first, so two workers never run the same one.
 */
const EVENT = { REORDER_NUDGE: 'ai.reorder', SLAB_PUSH: 'ai.slab', MECHANIC_NUDGE: 'ai.mechanic', PAYMENT_REMINDER: 'ai.payment' };

async function finish(id, status, fields = {}) {
  const { rows: [a] } = await query(
    `UPDATE ai_actions SET status=$2, result=$3, error=$4, executed_at=CASE WHEN $2='DONE' THEN now() ELSE executed_at END, updated_at=now() WHERE id=$1 RETURNING *`,
    [id, status, fields.result ? JSON.stringify(fields.result) : null, fields.error || null]);
  return a;
}

/** One AI dealer win-back campaign per brand per day; calls go out through the normal call worker. */
async function aiCallCampaign(db, tenant, language) {
  const name = `AI Channel Manager · ${ist().date}${language === 'en' ? ' (EN)' : ''}`;
  const { rows: [c] } = await db.query(`SELECT * FROM call_campaigns WHERE tenant_id=$1 AND source='ai' AND name=$2`, [tenant.id, name]);
  if (c) {
    if (c.status !== 'RUNNING') await db.query(`UPDATE call_campaigns SET status='RUNNING', completed_at=NULL WHERE id=$1`, [c.id]);
    return c;
  }
  const { rows: [n] } = await db.query(
    `INSERT INTO call_campaigns (tenant_id, name, script, language, provider, status, launched_at, source) VALUES ($1,$2,'DEALER_WINBACK',$3,$4,'RUNNING',now(),'ai') RETURNING *`,
    [tenant.id, name, language, config.calls.provider]);
  return n;
}

export async function executeAction(actionId, { now = new Date() } = {}) {
  // Claim
  const { rows: [a] } = await query(`UPDATE ai_actions SET status='EXECUTING', updated_at=now() WHERE id=$1 AND status='APPROVED' RETURNING *`, [actionId]);
  if (!a) return { skipped: 'not approved' };
  const { rows: [tenant] } = await query(`SELECT * FROM tenants WHERE id=$1`, [a.tenant_id]);
  const s = aiSettings(tenant);
  const channel = CHANNEL[a.type];
  if (channel !== 'INTERNAL' && !withinContactHours(s, now)) {
    await query(`UPDATE ai_actions SET status='APPROVED', updated_at=now() WHERE id=$1`, [a.id]);
    return { deferred: true };
  }
  const { rows: [p] } = a.participant_id ? await query(`SELECT * FROM participants WHERE id=$1`, [a.participant_id]) : { rows: [] };
  if (a.participant_id && (!p || p.status !== 'ACTIVE')) return { action: await finish(a.id, 'FAILED', { error: 'Participant is no longer active' }) };

  try {
    if (channel === 'WHATSAPP') {
      if (['REORDER_NUDGE', 'SLAB_PUSH', 'MECHANIC_NUDGE'].includes(a.type) && p.wa_opt_out) return { action: await finish(a.id, 'SKIPPED', { error: 'Opted out of offers (sent STOP)' }) };
      const r = await sendBusiness({ tenantId: tenant.id, participantId: p.id, to: p.mobile, eventType: EVENT[a.type], text: a.payload.message, params: a.payload.params || [] });
      if (r.status === 'no-template') return { action: await finish(a.id, 'FAILED', { error: `Needs an approved WhatsApp template for "${EVENT[a.type]}" (the dealer hasn't messaged in 24 hours)` }) };
      if (r.status === 'failed') return { action: await finish(a.id, 'FAILED', { error: r.error || 'WhatsApp send failed' }) };
      return { action: await finish(a.id, 'DONE', { result: { channel: 'WHATSAPP', via: r.status, messageId: r.messageId } }) };
    }

    if (a.type === 'WINBACK_CALL') {
      if (p.dnd) return { action: await finish(a.id, 'SKIPPED', { error: 'Do-not-call is on' }) };
      const call = await tx(async (db) => {
        const lang = a.payload.language || 'hi';
        const camp = await aiCallCampaign(db, tenant, lang);
        const w = await ledger.getWallet(db, p.id);
        const vars = { name: p.name || '', brand: tenant.name, balance: w.balance.toLocaleString('en-IN'), scheme: '', city: p.city || '', days: String(a.payload.quietDays || '') };
        const { rows: [k] } = await db.query(
          `INSERT INTO calls (tenant_id, campaign_id, participant_id, context) VALUES ($1,$2,$3,$4) ON CONFLICT (campaign_id, participant_id) DO UPDATE SET context=calls.context RETURNING *`,
          [tenant.id, camp.id, p.id, { vars, aiActionId: a.id, ...buildScript({ script: 'DEALER_WINBACK', language: lang, vars }) }]);
        return k;
      });
      return { action: await finish(a.id, 'DONE', { result: { channel: 'CALL', callId: call.id } }) };
    }

    if (a.type === 'FRAUD_REVIEW') {
      await tx(async (db) => {
        await db.query(`UPDATE participants SET status='BLOCKED' WHERE id=$1`, [p.id]);
        await emit(db, tenant.id, 'participant.blocked', { participantId: p.id, by: 'ai', actionId: a.id });
      });
      return { action: await finish(a.id, 'DONE', { result: { blocked: true, note: 'Scanning and cash-outs stopped. Pending payouts stay for your review in Redemptions.' } }) };
    }

    if (a.type === 'SCHEME_IDEA') {
      const scheme = await createScheme({ tenantId: tenant.id, adminId: null, body: { ...a.payload.draft, status: 'DRAFT' } });
      return { action: await finish(a.id, 'DONE', { result: { schemeId: scheme.id, note: 'Created as a draft. Review and activate it in Schemes.' } }) };
    }
    return { action: await finish(a.id, 'FAILED', { error: `Unknown action ${a.type}` }) };
  } catch (e) {
    return { action: await finish(a.id, 'FAILED', { error: e.message.slice(0, 300) }) };
  }
}

/** Approve or skip. `text` lets the owner edit the message before it goes. */
export async function decide({ tenantId, actionId, decision, text, by, now = new Date() }) {
  const { rows: [a] } = await query(`SELECT * FROM ai_actions WHERE id=$1 AND tenant_id=$2`, [actionId, tenantId]);
  if (!a) return { error: 'NOT_FOUND' };
  if (a.status !== 'PROPOSED') return { error: 'NOT_PENDING', status: a.status };
  if (decision === 'skip') {
    await query(`UPDATE ai_actions SET status='SKIPPED', decided_by=$2, updated_at=now() WHERE id=$1`, [a.id, by]);
    return { status: 'SKIPPED' };
  }
  const payload = { ...a.payload, ...(text && a.payload.message != null ? { message: String(text).slice(0, 1000), edited: true } : {}) };
  await query(`UPDATE ai_actions SET status='APPROVED', decided_by=$2, payload=$3, updated_at=now() WHERE id=$1`, [a.id, by, JSON.stringify(payload)]);
  const r = await executeAction(a.id, { now });
  return { status: r.deferred ? 'DEFERRED' : r.action?.status || 'APPROVED', error: r.action?.error || null };
}

/** Worker: run approved actions (deferred ones, AUTO ones). */
export async function executeApproved({ now = new Date(), limit = 50 } = {}) {
  const { rows } = await query(`SELECT id FROM ai_actions WHERE status='APPROVED' ORDER BY priority DESC LIMIT $1`, [limit]);
  let done = 0;
  for (const r of rows) { const x = await executeAction(r.id, { now }); if (x.action?.status === 'DONE') done++; }
  return done;
}
