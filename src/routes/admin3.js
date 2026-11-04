import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { ah, parse, notFound, conflict } from '../lib/errors.js';
import { requireAdmin, requireTenantScope } from '../middleware/auth.js';
import { getTenant } from '../services/tenants.js';
import { recomputeTenant, SEGMENTS } from '../services/segments.js';
import * as calls from '../services/calls/index.js';
import { createWaCampaign, launchWaCampaign, sendDue, waCampaignStats } from '../services/campaigns.js';
import { pushPlaced } from '../services/orders.js';
import { runExpiry } from '../services/expiry.js';

/** Phase 3 admin APIs: segments, AI call campaigns, WhatsApp orders, WhatsApp campaigns, expiry. */
const r = Router();
r.use(requireAdmin('SUPER_ADMIN', 'TENANT_ADMIN', 'TENANT_STAFF'), requireTenantScope);
const adminOnly = requireAdmin('SUPER_ADMIN', 'TENANT_ADMIN');
const PTYPES = ['DEALER', 'DISTRIBUTOR', 'RETAILER', 'MECHANIC', 'ELECTRICIAN', 'PLUMBER', 'CONTRACTOR', 'PAINTER', 'CARPENTER', 'OTHER'];
const asOfSchema = z.object({ asOf: z.string().datetime({ offset: true }).optional() });

// ================= Segments =================
r.get('/segments', ah(async (req, res) => {
  const { rows } = await query(`SELECT coalesce(segment,'UNSCORED') AS segment, type, count(*)::int AS n FROM participants WHERE tenant_id=$1 AND status='ACTIVE' GROUP BY 1,2`, [req.tenantId]);
  const bySegment = {}; for (const x of rows) bySegment[x.segment] = (bySegment[x.segment] || 0) + x.n;
  const { rows: recent } = await query(`
    SELECT s.segment, s.previous, s.computed_at, p.name, p.type, p.city FROM participant_segments s JOIN participants p ON p.id=s.participant_id
     WHERE s.tenant_id=$1 ORDER BY s.id DESC LIMIT 50`, [req.tenantId]);
  res.json({ segments: SEGMENTS, bySegment, byType: rows, recentChanges: recent });
}));
r.post('/segments/recompute', adminOnly, ah(async (req, res) => {
  const { asOf } = parse(asOfSchema, req.body || {});
  res.json(await recomputeTenant(await getTenant(req.tenantId), asOf ? new Date(asOf) : new Date()));
}));
r.post('/participants/:id/flags', ah(async (req, res) => {
  const b = parse(z.object({ dnd: z.boolean().optional(), waOptOut: z.boolean().optional() }), req.body);
  const { rows: [p] } = await query(`UPDATE participants SET dnd=coalesce($3,dnd), wa_opt_out=coalesce($4,wa_opt_out) WHERE id=$1 AND tenant_id=$2 RETURNING id, dnd, wa_opt_out`, [req.params.id, req.tenantId, b.dnd, b.waOptOut]);
  if (!p) throw notFound('Participant');
  res.json({ participant: p });
}));

// ================= AI call campaigns =================
const callBody = z.object({
  name: z.string().min(3), script: z.enum(['WINBACK', 'SCHEME_REMINDER', 'FEEDBACK']), language: z.enum(['hi', 'pa', 'en']).optional(),
  segments: z.array(z.enum(SEGMENTS)).optional(), participantTypes: z.array(z.enum(PTYPES)).optional(), city: z.string().optional(), schemeId: z.string().uuid().optional(),
});
r.get('/call-campaigns', ah(async (req, res) => {
  const { rows } = await query(`SELECT * FROM call_campaigns WHERE tenant_id=$1 ORDER BY created_at DESC`, [req.tenantId]);
  res.json({ campaigns: await Promise.all(rows.map(async (c) => ({ ...c, stats: await calls.campaignStats(c.id) }))) });
}));
r.post('/call-campaigns', adminOnly, ah(async (req, res) => {
  res.status(201).json({ campaign: await calls.createCampaign({ tenantId: req.tenantId, adminId: req.admin.id, body: parse(callBody, req.body) }) });
}));
r.post('/call-campaigns/:id/launch', adminOnly, ah(async (req, res) => res.json(await calls.launchCampaign({ tenantId: req.tenantId, campaignId: req.params.id }))));
r.post('/call-campaigns/:id/cancel', adminOnly, ah(async (req, res) => {
  const { rows: [c] } = await query(`UPDATE call_campaigns SET status='CANCELLED' WHERE id=$1 AND tenant_id=$2 AND status IN ('DRAFT','RUNNING') RETURNING *`, [req.params.id, req.tenantId]);
  if (!c) throw conflict('INVALID_STATE', 'Campaign already finished');
  await query(`UPDATE calls SET status='SKIPPED' WHERE campaign_id=$1 AND status='QUEUED'`, [c.id]);
  res.json({ campaign: c });
}));
r.get('/call-campaigns/:id/calls', ah(async (req, res) => {
  const { rows } = await query(`
    SELECT k.id, k.status, k.outcome, k.summary, k.attempted_at, k.completed_at, k.context->>'firstMessage' AS first_message,
           p.name, p.mobile, p.type, p.city, p.segment
      FROM calls k JOIN participants p ON p.id=k.participant_id WHERE k.campaign_id=$1 AND k.tenant_id=$2 ORDER BY k.created_at`, [req.params.id, req.tenantId]);
  res.json({ calls: rows });
}));
// Run the dialler now (the worker also does this every tick)
r.post('/call-campaigns/dispatch', adminOnly, ah(async (req, res) => res.json({ dispatched: await calls.dispatchDue() })));

// ================= Orders =================
r.get('/orders', ah(async (req, res) => {
  const params = [req.tenantId]; let where = `o.tenant_id=$1 AND o.status <> 'CART'`;
  if (req.query.status) { params.push(req.query.status); where = `o.tenant_id=$1 AND o.status=$2`; }
  const { rows } = await query(`
    SELECT o.*, p.name AS participant_name, p.mobile, p.city, p.type AS participant_type
      FROM orders o JOIN participants p ON p.id=o.participant_id WHERE ${where} ORDER BY coalesce(o.placed_at, o.created_at) DESC LIMIT 300`, params);
  res.json({ orders: rows });
}));
r.post('/orders/:id/retry', adminOnly, ah(async (req, res) => {
  const { rows: [o] } = await query(`UPDATE orders SET status='PLACED', attempts=0, error=NULL, updated_at=now() WHERE id=$1 AND tenant_id=$2 AND status IN ('FAILED','PLACED') RETURNING *`, [req.params.id, req.tenantId]);
  if (!o) throw conflict('INVALID_STATE', 'Only failed or placed orders can be retried');
  await pushPlaced();
  const { rows: [u] } = await query(`SELECT * FROM orders WHERE id=$1`, [o.id]);
  res.json({ order: u });
}));
// For brands without a DMS connection: mark processed by hand with their own order number
r.post('/orders/:id/ack', adminOnly, ah(async (req, res) => {
  const { ref } = parse(z.object({ ref: z.string().min(1).max(64) }), req.body);
  const { rows: [o] } = await query(`UPDATE orders SET status='SENT_TO_DMS', dms_order_ref=$3, error=NULL, updated_at=now() WHERE id=$1 AND tenant_id=$2 AND status IN ('PLACED','FAILED') RETURNING *`, [req.params.id, req.tenantId, ref]);
  if (!o) throw conflict('INVALID_STATE', 'Order is not waiting');
  await query(`INSERT INTO events (tenant_id, type, payload) VALUES ($1,'order.sent',$2)`, [o.tenant_id, { orderId: o.id, orderNo: o.order_no, participantId: o.participant_id, ref, totalPaise: Number(o.total_paise) }]);
  res.json({ order: o });
}));

// ================= WhatsApp campaigns =================
const waBody = z.object({
  name: z.string().min(3), templateName: z.string().min(1), language: z.string().max(10).optional(),
  params: z.array(z.string().max(500)).max(10).optional(), previewText: z.string().max(1000).optional(),
  segments: z.array(z.enum(SEGMENTS)).optional(), participantTypes: z.array(z.enum(PTYPES)).optional(), schemeId: z.string().uuid().optional(),
});
r.get('/wa-campaigns', ah(async (req, res) => {
  const { rows } = await query(`SELECT * FROM wa_campaigns WHERE tenant_id=$1 ORDER BY created_at DESC`, [req.tenantId]);
  res.json({ campaigns: await Promise.all(rows.map(async (c) => ({ ...c, stats: await waCampaignStats(c.id) }))) });
}));
r.post('/wa-campaigns', adminOnly, ah(async (req, res) => {
  res.status(201).json({ campaign: await createWaCampaign({ tenantId: req.tenantId, adminId: req.admin.id, body: parse(waBody, req.body) }) });
}));
r.post('/wa-campaigns/:id/launch', adminOnly, ah(async (req, res) => res.json(await launchWaCampaign({ tenantId: req.tenantId, campaignId: req.params.id }))));
r.post('/wa-campaigns/:id/cancel', adminOnly, ah(async (req, res) => {
  const { rows: [c] } = await query(`UPDATE wa_campaigns SET status='CANCELLED' WHERE id=$1 AND tenant_id=$2 AND status IN ('DRAFT','RUNNING') RETURNING *`, [req.params.id, req.tenantId]);
  if (!c) throw conflict('INVALID_STATE', 'Campaign already finished');
  await query(`UPDATE wa_campaign_recipients SET status='SKIPPED', updated_at=now() WHERE campaign_id=$1 AND status='QUEUED'`, [c.id]);
  res.json({ campaign: c });
}));
r.post('/wa-campaigns/run', adminOnly, ah(async (req, res) => res.json({ sent: await sendDue() })));

// ================= Points expiry =================
r.post('/expiry/run', adminOnly, ah(async (req, res) => {
  const { asOf } = parse(asOfSchema, req.body || {});
  res.json(await runExpiry(asOf ? new Date(asOf) : new Date(), req.tenantId));
}));

export default r;
