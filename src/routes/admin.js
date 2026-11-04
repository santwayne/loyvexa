import { Router } from 'express';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { z } from 'zod';
import { query, tx } from '../db/pool.js';
import { ah, parse, notFound, conflict, badRequest } from '../lib/errors.js';
import { requireAdmin, requireTenantScope } from '../middleware/auth.js';
import { normalizeMobile } from '../lib/codes.js';
import { getTenant, settingsOf } from '../services/tenants.js';
import * as qr from '../services/qr.js';
import * as ledger from '../services/ledger.js';
import { processRedemption, rejectRedemption, isValidUpi } from '../services/redemption.js';
import { emit } from '../services/events.js';

const r = Router();
r.use(requireAdmin('SUPER_ADMIN', 'TENANT_ADMIN', 'TENANT_STAFF'), requireTenantScope);
const adminOnly = requireAdmin('SUPER_ADMIN', 'TENANT_ADMIN');

const PTYPES = ['DEALER', 'DISTRIBUTOR', 'RETAILER', 'MECHANIC', 'ELECTRICIAN', 'PLUMBER', 'CONTRACTOR', 'PAINTER', 'CARPENTER', 'OTHER'];
const page = (q) => ({ limit: Math.min(Number(q.limit) || 50, 500), offset: Math.max(Number(q.offset) || 0, 0) });

// ---------- Brand settings ----------
r.get('/tenant', ah(async (req, res) => {
  const t = await getTenant(req.tenantId);
  res.json({ tenant: { ...t, settings: settingsOf(t) } });
}));

r.patch('/tenant', adminOnly, ah(async (req, res) => {
  const b = parse(z.object({ brandColor: z.string().optional(), logoUrl: z.string().url().optional(), settings: z.record(z.string(), z.any()).optional() }), req.body);
  const { rows: [t] } = await query(
    `UPDATE tenants SET brand_color=coalesce($2,brand_color), logo_url=coalesce($3,logo_url), settings = settings || coalesce($4::jsonb,'{}'::jsonb) WHERE id=$1 RETURNING *`,
    [req.tenantId, b.brandColor, b.logoUrl, b.settings ? JSON.stringify(b.settings) : null]);
  res.json({ tenant: { ...t, settings: settingsOf(t) } });
}));

// ---------- Team (brand admin users) ----------
r.get('/users', adminOnly, ah(async (req, res) => {
  const { rows } = await query(`SELECT id, name, email, role, status, last_login_at FROM admin_users WHERE tenant_id=$1 ORDER BY created_at`, [req.tenantId]);
  res.json({ users: rows });
}));
r.post('/users', adminOnly, ah(async (req, res) => {
  const b = parse(z.object({ name: z.string().min(2), email: z.string().email(), password: z.string().min(8), role: z.enum(['TENANT_ADMIN', 'TENANT_STAFF']) }), req.body);
  try {
    const { rows: [u] } = await query(`INSERT INTO admin_users (tenant_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email, role`,
      [req.tenantId, b.name, b.email.toLowerCase(), await bcrypt.hash(b.password, 10), b.role]);
    res.status(201).json({ user: u });
  } catch (e) { if (e.code === '23505') throw conflict('EMAIL_TAKEN', 'Email already used'); throw e; }
}));

// ---------- Products ----------
const productSchema = z.object({
  sku: z.string().min(1).max(64), name: z.string().min(1), category: z.string().optional(),
  mrpPaise: z.number().int().nonnegative().optional(), points: z.number().int().nonnegative(),
  pointsByType: z.record(z.string(), z.number().int().nonnegative())
    .refine((o) => Object.keys(o).every((k) => PTYPES.includes(k)), 'Unknown participant type').optional(),
  active: z.boolean().optional(), externalRef: z.string().optional(),
});
r.get('/products', ah(async (req, res) => {
  const { rows } = await query(`
    SELECT p.*, (SELECT count(*) FROM qr_codes q WHERE q.product_id=p.id) AS codes_generated,
                (SELECT count(*) FROM qr_codes q WHERE q.product_id=p.id AND q.status='SCANNED') AS codes_scanned
      FROM products p WHERE tenant_id=$1 ORDER BY name`, [req.tenantId]);
  res.json({ products: rows });
}));
r.post('/products', adminOnly, ah(async (req, res) => {
  const b = parse(productSchema, req.body);
  try {
    const { rows: [p] } = await query(
      `INSERT INTO products (tenant_id, sku, name, category, mrp_paise, points, points_by_type, active, external_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8,true),$9) RETURNING *`,
      [req.tenantId, b.sku, b.name, b.category, b.mrpPaise, b.points, b.pointsByType || {}, b.active, b.externalRef]);
    res.status(201).json({ product: p });
  } catch (e) { if (e.code === '23505') throw conflict('SKU_EXISTS', 'SKU already exists'); throw e; }
}));
r.patch('/products/:id', adminOnly, ah(async (req, res) => {
  const b = parse(productSchema.partial(), req.body);
  const { rows: [p] } = await query(
    `UPDATE products SET name=coalesce($3,name), category=coalesce($4,category), mrp_paise=coalesce($5,mrp_paise),
       points=coalesce($6,points), points_by_type=coalesce($7,points_by_type), active=coalesce($8,active)
     WHERE id=$1 AND tenant_id=$2 RETURNING *`,
    [req.params.id, req.tenantId, b.name, b.category, b.mrpPaise, b.points, b.pointsByType ? JSON.stringify(b.pointsByType) : null, b.active]);
  if (!p) throw notFound('Product');
  res.json({ product: p });
}));

// ---------- QR batches ----------
r.post('/qr-batches', adminOnly, ah(async (req, res) => {
  const b = parse(z.object({ productId: z.string().uuid(), quantity: z.number().int().positive(), label: z.string().optional(), mfgDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.body);
  const batch = await qr.createBatch({ tenantId: req.tenantId, ...b, createdBy: req.admin.id });
  res.status(201).json({ batch, csvUrl: `/api/admin/qr-batches/${batch.id}/export.csv` });
}));
r.get('/qr-batches', ah(async (req, res) => {
  const { rows } = await query(`
    SELECT b.*, p.sku, p.name AS product_name,
      (SELECT count(*) FROM qr_codes q WHERE q.batch_id=b.id AND q.status='SCANNED') AS scanned
    FROM qr_batches b JOIN products p ON p.id=b.product_id WHERE b.tenant_id=$1 ORDER BY b.created_at DESC`, [req.tenantId]);
  res.json({ batches: rows });
}));
r.get('/qr-batches/:id/export.csv', ah(async (req, res) => qr.streamBatchCsv(res, { tenantId: req.tenantId, batchId: req.params.id })));
r.post('/qr-batches/:id/void', adminOnly, ah(async (req, res) => {
  const { rows: [b] } = await query(`UPDATE qr_batches SET status='VOID' WHERE id=$1 AND tenant_id=$2 RETURNING *`, [req.params.id, req.tenantId]);
  if (!b) throw notFound('Batch');
  const u = await query(`UPDATE qr_codes SET status='VOID' WHERE batch_id=$1 AND status='UNUSED'`, [b.id]);
  res.json({ batch: b, voidedCodes: u.rowCount });
}));
r.get('/qr/:code.png', ah(async (req, res) => {
  const { rows: [c] } = await query(`SELECT code FROM qr_codes WHERE code=$1 AND tenant_id=$2`, [req.params.code.toUpperCase(), req.tenantId]);
  if (!c) throw notFound('Code');
  res.type('png').send(await QRCode.toBuffer(qr.codeUrl(c.code), { errorCorrectionLevel: 'M', margin: 1, width: 360 }));
}));
r.get('/qr/:code', ah(async (req, res) => {
  const { rows: [c] } = await query(`
    SELECT q.*, p.sku, p.name AS product_name, pa.name AS scanned_by_name, pa.mobile AS scanned_by_mobile
      FROM qr_codes q JOIN products p ON p.id=q.product_id LEFT JOIN participants pa ON pa.id=q.scanned_by
     WHERE q.code=$1 AND q.tenant_id=$2`, [req.params.code.toUpperCase(), req.tenantId]);
  if (!c) throw notFound('Code');
  res.json({ code: c });
}));

// ---------- Participants ----------
const participantSchema = z.object({
  type: z.enum(PTYPES), name: z.string().min(1), mobile: z.string(), city: z.string().optional(), state: z.string().optional(),
  pincode: z.string().optional(), upiId: z.string().optional(), parentId: z.string().uuid().optional(), externalRef: z.string().optional(),
  language: z.string().max(5).optional(),
});
r.get('/participants', ah(async (req, res) => {
  const { limit, offset } = page(req.query);
  const params = [req.tenantId];
  const where = ['p.tenant_id=$1'];
  if (req.query.type) { params.push(req.query.type); where.push(`p.type=$${params.length}`); }
  if (req.query.status) { params.push(req.query.status); where.push(`p.status=$${params.length}`); }
  if (req.query.q) { params.push(`%${req.query.q}%`); where.push(`(p.name ILIKE $${params.length} OR p.mobile ILIKE $${params.length} OR p.city ILIKE $${params.length})`); }
  params.push(limit, offset);
  const { rows } = await query(`
    SELECT p.id, p.type, p.name, p.mobile, p.city, p.state, p.status, p.upi_id, p.last_scan_at, p.created_at, p.external_ref,
           coalesce(w.balance,0) AS balance, coalesce(w.lifetime_earned,0) AS lifetime_earned, count(*) OVER() AS total
      FROM participants p LEFT JOIN wallets w ON w.participant_id=p.id
     WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ participants: rows, total: Number(rows[0]?.total || 0) });
}));
r.post('/participants', ah(async (req, res) => {
  const b = parse(participantSchema, req.body);
  const mobile = normalizeMobile(b.mobile);
  if (!mobile) throw badRequest('INVALID_MOBILE', 'Invalid mobile number');
  if (b.upiId && !isValidUpi(b.upiId)) throw badRequest('INVALID_UPI', 'Invalid UPI ID');
  const p = await tx(async (db) => {
    try {
      const { rows: [p] } = await db.query(
        `INSERT INTO participants (tenant_id, type, name, mobile, city, state, pincode, upi_id, parent_id, external_ref, language)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11,'hi')) RETURNING *`,
        [req.tenantId, b.type, b.name, mobile, b.city, b.state, b.pincode, b.upiId, b.parentId, b.externalRef, b.language]);
      await db.query(`INSERT INTO wallets (participant_id, tenant_id) VALUES ($1,$2)`, [p.id, req.tenantId]);
      await emit(db, req.tenantId, 'participant.created', { participantId: p.id, type: p.type, source: 'admin' });
      return p;
    } catch (e) { if (e.code === '23505') throw conflict('MOBILE_EXISTS', 'This mobile is already registered'); throw e; }
  });
  res.status(201).json({ participant: p });
}));
r.get('/participants/:id', ah(async (req, res) => {
  const { rows: [p] } = await query(`SELECT * FROM participants WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.tenantId]);
  if (!p) throw notFound('Participant');
  const [wallet, entries, flags, redemptions] = await Promise.all([
    ledger.getWallet({ query }, p.id),
    query(`SELECT * FROM ledger_entries WHERE participant_id=$1 ORDER BY id DESC LIMIT 100`, [p.id]),
    query(`SELECT * FROM fraud_flags WHERE participant_id=$1 ORDER BY created_at DESC LIMIT 50`, [p.id]),
    query(`SELECT * FROM redemptions WHERE participant_id=$1 ORDER BY created_at DESC LIMIT 50`, [p.id]),
  ]);
  res.json({ participant: p, wallet, ledger: entries.rows, fraudFlags: flags.rows, redemptions: redemptions.rows });
}));
r.patch('/participants/:id', ah(async (req, res) => {
  const b = parse(participantSchema.partial().extend({ status: z.enum(['ACTIVE', 'BLOCKED']).optional(), clearScanBlock: z.boolean().optional() }), req.body);
  if (b.upiId && !isValidUpi(b.upiId)) throw badRequest('INVALID_UPI', 'Invalid UPI ID');
  const { rows: [p] } = await query(
    `UPDATE participants SET name=coalesce($3,name), type=coalesce($4,type), city=coalesce($5,city), state=coalesce($6,state),
       pincode=coalesce($7,pincode), upi_id=coalesce($8,upi_id), status=coalesce($9,status), parent_id=coalesce($10,parent_id),
       external_ref=coalesce($11,external_ref), scan_blocked_until = CASE WHEN $12 THEN NULL ELSE scan_blocked_until END
     WHERE id=$1 AND tenant_id=$2 RETURNING *`,
    [req.params.id, req.tenantId, b.name, b.type, b.city, b.state, b.pincode, b.upiId, b.status, b.parentId, b.externalRef, !!b.clearScanBlock]);
  if (!p) throw notFound('Participant');
  res.json({ participant: p });
}));
r.post('/participants/:id/adjust', adminOnly, ah(async (req, res) => {
  const b = parse(z.object({ points: z.number().int().refine((v) => v !== 0), note: z.string().min(3), idempotencyKey: z.string().min(6) }), req.body);
  const wallet = await tx(async (db) => {
    const { rows: [p] } = await db.query(`SELECT id FROM participants WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.tenantId]);
    if (!p) throw notFound('Participant');
    const w = await ledger.post(db, {
      tenantId: req.tenantId, participantId: p.id, type: b.points > 0 ? 'ADJUST_CREDIT' : 'ADJUST_DEBIT', points: b.points,
      refType: 'manual', refId: b.idempotencyKey, note: b.note, createdBy: req.admin.id,
    });
    await emit(db, req.tenantId, 'points.adjusted', { participantId: p.id, points: b.points, note: b.note, by: req.admin.id });
    return w;
  });
  res.json({ wallet });
}));

// ---------- Redemptions ----------
r.get('/redemptions', ah(async (req, res) => {
  const { limit, offset } = page(req.query);
  const params = [req.tenantId];
  let where = 'r.tenant_id=$1';
  if (req.query.status) { params.push(req.query.status); where += ` AND r.status=$${params.length}`; }
  params.push(limit, offset);
  const { rows } = await query(`
    SELECT r.*, p.name AS participant_name, p.mobile, p.type AS participant_type, p.city
      FROM redemptions r JOIN participants p ON p.id=r.participant_id
     WHERE ${where} ORDER BY r.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ redemptions: rows });
}));
r.post('/redemptions/:id/approve', adminOnly, ah(async (req, res) => {
  res.json({ redemption: await processRedemption({ tenantId: req.tenantId, redemptionId: req.params.id, approvedBy: req.admin.id }) });
}));
r.post('/redemptions/:id/reject', adminOnly, ah(async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().min(3) }), req.body);
  res.json({ redemption: await rejectRedemption({ tenantId: req.tenantId, redemptionId: req.params.id, adminId: req.admin.id, reason }) });
}));

// ---------- Fraud ----------
r.get('/fraud-flags', ah(async (req, res) => {
  const { rows } = await query(`
    SELECT f.*, p.name AS participant_name, p.mobile, p.type AS participant_type
      FROM fraud_flags f LEFT JOIN participants p ON p.id=f.participant_id
     WHERE f.tenant_id=$1 AND f.status=coalesce($2,'OPEN') ORDER BY f.created_at DESC LIMIT 200`, [req.tenantId, req.query.status || null]);
  res.json({ flags: rows });
}));
r.post('/fraud-flags/:id/resolve', ah(async (req, res) => {
  const { rows: [f] } = await query(`UPDATE fraud_flags SET status='RESOLVED', resolved_by=$3 WHERE id=$1 AND tenant_id=$2 RETURNING *`, [req.params.id, req.tenantId, req.admin.id]);
  if (!f) throw notFound('Flag');
  res.json({ flag: f });
}));

// ---------- Dashboard ----------
r.get('/dashboard', ah(async (req, res) => {
  const t = req.tenantId;
  const days = Math.min(Number(req.query.days) || 30, 365);
  const [kpi, byType, daily, topEarners, byCity, topProducts, counterfeit] = await Promise.all([
    query(`SELECT
        (SELECT count(*) FROM participants WHERE tenant_id=$1) AS participants,
        (SELECT count(*) FROM participants WHERE tenant_id=$1 AND last_scan_at > now() - interval '30 days') AS active_30d,
        (SELECT count(*) FROM participants WHERE tenant_id=$1 AND last_scan_at IS NOT NULL AND last_scan_at <= now() - interval '30 days') AS dormant,
        (SELECT count(*) FROM qr_codes WHERE tenant_id=$1) AS codes_generated,
        (SELECT count(*) FROM qr_codes WHERE tenant_id=$1 AND status='SCANNED') AS codes_scanned,
        (SELECT count(*) FROM qr_codes WHERE tenant_id=$1 AND scanned_at > date_trunc('day', now())) AS scans_today,
        (SELECT coalesce(sum(points),0) FROM ledger_entries WHERE tenant_id=$1 AND type='EARN_SCAN') AS points_issued,
        (SELECT coalesce(sum(balance+held),0) FROM wallets WHERE tenant_id=$1) AS points_liability,
        (SELECT coalesce(sum(amount_paise),0) FROM redemptions WHERE tenant_id=$1 AND status='PAID') AS paid_paise,
        (SELECT count(*) FROM redemptions WHERE tenant_id=$1 AND status='REQUESTED') AS pending_redemptions,
        (SELECT count(*) FROM fraud_flags WHERE tenant_id=$1 AND status='OPEN') AS open_fraud_flags`, [t]),
    query(`SELECT type, count(*) AS n, count(*) FILTER (WHERE last_scan_at > now() - interval '30 days') AS active FROM participants WHERE tenant_id=$1 GROUP BY type ORDER BY n DESC`, [t]),
    query(`SELECT d::date AS day, coalesce(s.n,0) AS scans, coalesce(s.pts,0) AS points
             FROM generate_series(date_trunc('day', now()) - make_interval(days => $2 - 1), date_trunc('day', now()), interval '1 day') d
             LEFT JOIN (SELECT date_trunc('day', created_at) AS day, count(*) AS n, sum(points) AS pts FROM ledger_entries
                         WHERE tenant_id=$1 AND type='EARN_SCAN' GROUP BY 1) s ON s.day = d ORDER BY d`, [t, days]),
    query(`SELECT p.id, p.name, p.type, p.city, w.lifetime_earned FROM wallets w JOIN participants p ON p.id=w.participant_id
            WHERE w.tenant_id=$1 ORDER BY w.lifetime_earned DESC LIMIT 10`, [t]),
    query(`SELECT coalesce(p.city,'Unknown') AS city, count(*) AS scans FROM qr_codes q JOIN participants p ON p.id=q.scanned_by
            WHERE q.tenant_id=$1 AND q.scanned_at > now() - make_interval(days => $2) GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, [t, days]),
    query(`SELECT pr.sku, pr.name, count(*) AS scans FROM qr_codes q JOIN products pr ON pr.id=q.product_id
            WHERE q.tenant_id=$1 AND q.scanned_at > now() - make_interval(days => $2) GROUP BY 1,2 ORDER BY 3 DESC LIMIT 10`, [t, days]),
    query(`SELECT count(*) FILTER (WHERE result='ALREADY_SCANNED') AS reused_code_checks,
                  count(*) FILTER (WHERE result='VOID') AS void_code_checks,
                  count(*) AS total_checks
             FROM verify_checks WHERE tenant_id=$1 AND created_at > now() - make_interval(days => $2)`, [t, days]),
  ]);
  const k = kpi.rows[0];
  res.json({
    kpis: Object.fromEntries(Object.entries(k).map(([a, v]) => [a, Number(v)])),
    participantsByType: byType.rows, daily: daily.rows, topEarners: topEarners.rows,
    scansByCity: byCity.rows, topProducts: topProducts.rows, authenticity: counterfeit.rows[0],
  });
}));

export default r;
