import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { ah, parse, notFound, badRequest, conflict } from '../lib/errors.js';
import { requireAdmin, requireTenantScope } from '../middleware/auth.js';
import { sha256 } from '../lib/codes.js';
import { newApiKey, encrypt } from '../lib/crypto.js';
import { config } from '../config.js';
import { parseDocuments } from '../connectors/adapters.js';
import { ingestDocuments, assignInvoice } from '../services/invoices.js';
import * as schemes from '../services/schemes.js';
import { handleInbound } from '../services/bot.js';
import { getTenant } from '../services/tenants.js';

const r = Router();
r.use(requireAdmin('SUPER_ADMIN', 'TENANT_ADMIN', 'TENANT_STAFF'), requireTenantScope);
const adminOnly = requireAdmin('SUPER_ADMIN', 'TENANT_ADMIN');
const CONNECTOR_TYPES = ['GENERIC', 'TALLY', 'ZOHO_BOOKS', 'BUSY', 'MARG', 'ROYAL', 'CSV'];

// ================= Connectors =================
const connectorView = (c) => ({ id: c.id, type: c.type, name: c.name, keyPrefix: c.api_key_prefix, config: c.config, status: c.status, lastReceivedAt: c.last_received_at, createdAt: c.created_at });
const endpoints = () => ({
  invoices: `${config.publicBaseUrl}/api/connect/invoices`, parties: `${config.publicBaseUrl}/api/connect/parties`,
  royal: `${config.publicBaseUrl}/api/connect/royal`, ping: `${config.publicBaseUrl}/api/connect/ping`,
});
const connectorConfig = z.object({
  earnPurchasePoints: z.boolean().optional(),
  earnOn: z.enum(['approved', 'delivered']).optional(),
  columns: z.record(z.string(), z.array(z.string())).optional(),
}).optional();

r.get('/connectors', ah(async (req, res) => {
  const { rows } = await query(`
    SELECT c.*, (SELECT count(*) FROM invoices i WHERE i.connector_id=c.id) AS documents,
           (SELECT count(*) FROM invoices i WHERE i.connector_id=c.id AND i.status='UNMATCHED') AS unmatched
      FROM connectors c WHERE tenant_id=$1 ORDER BY created_at`, [req.tenantId]);
  res.json({ connectors: rows.map((c) => ({ ...connectorView(c), documents: Number(c.documents), unmatched: Number(c.unmatched) })), endpoints: endpoints() });
}));

r.post('/connectors', adminOnly, ah(async (req, res) => {
  const b = parse(z.object({ type: z.enum(CONNECTOR_TYPES), name: z.string().min(2), config: connectorConfig }), req.body);
  const key = newApiKey('lvx');
  const { rows: [c] } = await query(
    `INSERT INTO connectors (tenant_id, type, name, api_key_hash, api_key_prefix, config) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.tenantId, b.type, b.name, sha256(key), key.slice(0, 10), b.config || {}]);
  res.status(201).json({ connector: connectorView(c), apiKey: key, endpoints: endpoints(), note: 'Copy the API key now — it is not shown again.' });
}));

r.patch('/connectors/:id', adminOnly, ah(async (req, res) => {
  const b = parse(z.object({ name: z.string().optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional(), config: connectorConfig }), req.body);
  const { rows: [c] } = await query(
    `UPDATE connectors SET name=coalesce($3,name), status=coalesce($4,status), config = config || coalesce($5::jsonb,'{}'::jsonb) WHERE id=$1 AND tenant_id=$2 RETURNING *`,
    [req.params.id, req.tenantId, b.name, b.status, b.config ? JSON.stringify(b.config) : null]);
  if (!c) throw notFound('Connector');
  res.json({ connector: connectorView(c) });
}));

r.post('/connectors/:id/rotate-key', adminOnly, ah(async (req, res) => {
  const key = newApiKey('lvx');
  const { rows: [c] } = await query(`UPDATE connectors SET api_key_hash=$3, api_key_prefix=$4 WHERE id=$1 AND tenant_id=$2 RETURNING *`, [req.params.id, req.tenantId, sha256(key), key.slice(0, 10)]);
  if (!c) throw notFound('Connector');
  res.json({ connector: connectorView(c), apiKey: key });
}));

// Upload a CSV / XML / JSON export by hand from the console (Busy, Marg, Excel…)
r.post('/connectors/:id/upload', adminOnly, ah(async (req, res) => {
  const { content } = parse(z.object({ content: z.string().min(10).max(20_000_000) }), req.body);
  const { rows: [c] } = await query(`SELECT * FROM connectors WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.tenantId]);
  if (!c) throw notFound('Connector');
  let body; try { body = JSON.parse(content); } catch { body = undefined; }
  const docs = parseDocuments(c.type, { body, rawText: content, config: c.config });
  res.json(await ingestDocuments({ connector: c, docs }));
}));

// ================= Invoices =================
r.get('/invoices', ah(async (req, res) => {
  const params = [req.tenantId]; const where = ['i.tenant_id=$1'];
  if (req.query.status) { params.push(req.query.status); where.push(`i.status=$${params.length}`); }
  if (req.query.participantId) { params.push(req.query.participantId); where.push(`i.participant_id=$${params.length}`); }
  params.push(Math.min(Number(req.query.limit) || 100, 500));
  const { rows } = await query(`
    SELECT i.id, i.source, i.external_id, i.raw->>'voucherNumber' AS voucher_number, i.doc_type, i.invoice_date, i.party_ref, i.party_gstin, i.party_mobile, i.party_name,
           i.total_paise, i.status, i.base_points, i.created_at, p.name AS participant_name, c.name AS connector_name,
           (SELECT count(*) FROM invoice_lines l WHERE l.invoice_id=i.id AND l.product_id IS NULL) AS unknown_items
      FROM invoices i LEFT JOIN participants p ON p.id=i.participant_id LEFT JOIN connectors c ON c.id=i.connector_id
     WHERE ${where.join(' AND ')} ORDER BY i.created_at DESC LIMIT $${params.length}`, params);
  res.json({ invoices: rows });
}));
r.get('/invoices/:id', ah(async (req, res) => {
  const { rows: [i] } = await query(`SELECT * FROM invoices WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.tenantId]);
  if (!i) throw notFound('Invoice');
  const { rows: lines } = await query(`SELECT l.*, p.sku AS matched_sku, p.name AS matched_name FROM invoice_lines l LEFT JOIN products p ON p.id=l.product_id WHERE invoice_id=$1`, [i.id]);
  res.json({ invoice: i, lines });
}));
r.post('/invoices/:id/assign', adminOnly, ah(async (req, res) => {
  const b = parse(z.object({ participantId: z.string().uuid(), remember: z.boolean().optional() }), req.body);
  const out = await assignInvoice({ tenantId: req.tenantId, invoiceId: req.params.id, participantId: b.participantId, remember: b.remember !== false });
  if (!out) throw notFound('Invoice or participant');
  res.json(out);
}));
r.post('/invoices/:id/ignore', adminOnly, ah(async (req, res) => {
  const { rows: [i] } = await query(`UPDATE invoices SET status='IGNORED' WHERE id=$1 AND tenant_id=$2 AND status='UNMATCHED' RETURNING id, status`, [req.params.id, req.tenantId]);
  if (!i) throw conflict('INVALID_STATE', 'Only unmatched invoices can be ignored');
  res.json({ invoice: i });
}));

// ================= Schemes =================
const slab = z.object({ min: z.number().positive(), rewardType: z.enum(['FIXED_POINTS', 'PERCENT', 'PER_UNIT']), value: z.number().positive(), label: z.string().max(40).optional() });
const schemeBody = z.object({
  name: z.string().min(3), description: z.string().max(500).optional(),
  type: z.enum(['PURCHASE_SLAB', 'SCAN_TARGET', 'SCAN_MULTIPLIER']), metric: z.enum(['AMOUNT', 'QUANTITY', 'SCANS']),
  startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }),
  settleGraceDays: z.number().int().min(0).max(30).optional(),
  eligibleTypes: z.array(z.string()).optional(), productIds: z.array(z.string().uuid()).optional(),
  slabs: z.array(slab).max(20).optional(), multiplier: z.number().optional(), status: z.enum(['DRAFT', 'ACTIVE']).optional(),
});

r.get('/schemes', ah(async (req, res) => {
  const { rows } = await query(`SELECT s.*, (SELECT count(*) FROM scheme_results x WHERE x.scheme_id=s.id AND x.points>0) AS winners,
      (SELECT coalesce(sum(points),0) FROM scheme_results x WHERE x.scheme_id=s.id) AS paid_points
    FROM schemes s WHERE tenant_id=$1 ORDER BY created_at DESC`, [req.tenantId]);
  res.json({ schemes: rows });
}));
r.post('/schemes', adminOnly, ah(async (req, res) => {
  const b = parse(schemeBody, req.body);
  res.status(201).json({ scheme: await schemes.createScheme({ tenantId: req.tenantId, adminId: req.admin.id, body: b }) });
}));
r.patch('/schemes/:id', adminOnly, ah(async (req, res) => {
  const cur = await schemes.getScheme({ query }, req.tenantId, req.params.id);
  if (cur.status !== 'DRAFT') throw conflict('LOCKED', 'Only draft schemes can be edited. Cancel and create a new one.');
  const merged = schemes.validateScheme({
    name: cur.name, description: cur.description, type: cur.type, metric: cur.metric, startsAt: cur.starts_at, endsAt: cur.ends_at,
    settleGraceDays: cur.settle_grace_days, eligibleTypes: cur.eligible_types, productIds: cur.product_ids, slabs: cur.slabs, multiplier: cur.multiplier,
    ...parse(schemeBody.partial(), req.body),
  });
  const { rows: [s] } = await query(
    `UPDATE schemes SET name=$3, description=$4, type=$5, metric=$6, starts_at=$7, ends_at=$8, settle_grace_days=$9, eligible_types=$10, product_ids=$11, slabs=$12, multiplier=$13
      WHERE id=$1 AND tenant_id=$2 RETURNING *`,
    [cur.id, req.tenantId, merged.name, merged.description, merged.type, merged.metric, merged.startsAt, merged.endsAt, merged.settleGraceDays,
      merged.eligibleTypes || [], merged.productIds || [], JSON.stringify(merged.slabs), merged.multiplier || null]);
  res.json({ scheme: s });
}));
r.post('/schemes/:id/activate', adminOnly, ah(async (req, res) => {
  const { rows: [s] } = await query(`UPDATE schemes SET status='ACTIVE' WHERE id=$1 AND tenant_id=$2 AND status='DRAFT' AND ends_at > now() RETURNING *`, [req.params.id, req.tenantId]);
  if (!s) throw conflict('INVALID_STATE', 'Only a draft scheme that has not ended can be activated');
  res.json({ scheme: s });
}));
r.post('/schemes/:id/cancel', adminOnly, ah(async (req, res) => {
  const { rows: [s] } = await query(`UPDATE schemes SET status='CANCELLED' WHERE id=$1 AND tenant_id=$2 AND status IN ('DRAFT','ACTIVE') RETURNING *`, [req.params.id, req.tenantId]);
  if (!s) throw conflict('INVALID_STATE', 'Scheme already settled or cancelled');
  res.json({ scheme: s });
}));
r.get('/schemes/:id/leaderboard', ah(async (req, res) => res.json(await schemes.leaderboard({ tenantId: req.tenantId, schemeId: req.params.id, limit: Math.min(Number(req.query.limit) || 100, 1000) }))));
r.post('/schemes/:id/settle', adminOnly, ah(async (req, res) => res.json(await schemes.settleScheme({ tenantId: req.tenantId, schemeId: req.params.id, force: req.body?.force === true }))));

// ================= WhatsApp =================
r.get('/channels/whatsapp', ah(async (req, res) => {
  const { rows: [c] } = await query(`SELECT id, phone_number_id, display_number, config, status, created_at, access_token_enc IS NOT NULL AS has_token FROM tenant_channels WHERE tenant_id=$1 AND channel='WHATSAPP'`, [req.tenantId]);
  res.json({ channel: c || null, webhookUrl: `${config.publicBaseUrl}/api/whatsapp/webhook`, sendMode: config.whatsapp.sendMode });
}));
r.put('/channels/whatsapp', adminOnly, ah(async (req, res) => {
  const b = parse(z.object({
    phoneNumberId: z.string().min(5), displayNumber: z.string().optional(), accessToken: z.string().min(20).optional(),
    otpTemplate: z.object({ name: z.string(), language: z.string().optional() }).optional(),
    templates: z.record(z.string(), z.object({ name: z.string(), language: z.string().optional() })).optional(),
  }), req.body);
  const cfg = { ...(b.otpTemplate ? { otpTemplate: b.otpTemplate } : {}), ...(b.templates ? { templates: b.templates } : {}) };
  try {
    const { rows: [c] } = await query(`
      INSERT INTO tenant_channels (tenant_id, channel, phone_number_id, display_number, access_token_enc, config)
      VALUES ($1,'WHATSAPP',$2,$3,$4,$5)
      ON CONFLICT (tenant_id, channel) DO UPDATE SET phone_number_id=EXCLUDED.phone_number_id, display_number=coalesce(EXCLUDED.display_number, tenant_channels.display_number),
        access_token_enc=coalesce(EXCLUDED.access_token_enc, tenant_channels.access_token_enc), config = tenant_channels.config || EXCLUDED.config, status='ACTIVE'
      RETURNING id, phone_number_id, display_number, config, status`,
    [req.tenantId, b.phoneNumberId, b.displayNumber || null, b.accessToken ? encrypt(b.accessToken) : null, cfg]);
    res.json({ channel: c });
  } catch (e) { if (e.code === '23505') throw conflict('NUMBER_IN_USE', 'This WhatsApp number is connected to another brand'); throw e; }
}));
r.get('/messages', ah(async (req, res) => {
  const params = [req.tenantId]; let where = 'm.tenant_id=$1';
  if (req.query.peer) { params.push(req.query.peer); where += ` AND m.peer=$${params.length}`; }
  const { rows } = await query(`SELECT m.id, m.direction, m.peer, m.body, m.status, m.error, m.created_at, p.name AS participant_name FROM messages m LEFT JOIN participants p ON p.id=m.participant_id WHERE ${where} ORDER BY m.id DESC LIMIT 200`, params);
  res.json({ messages: rows });
}));
// Test the bot from the console without a real WhatsApp number
r.post('/whatsapp/simulate', ah(async (req, res) => {
  const b = parse(z.object({ from: z.string().min(10), text: z.string().min(1).max(1000) }), req.body);
  const tenant = await getTenant(req.tenantId);
  const reply = await handleInbound({ channel: { tenant, tenant_id: tenant.id }, from: b.from.replace(/\D/g, ''), text: b.text, providerMsgId: null });
  if (reply == null) throw badRequest('NO_REPLY', 'No reply generated');
  res.json({ reply });
}));

export default r;
