import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { ah, parse, notFound, badRequest, unauthorized, forbidden, conflict } from '../lib/errors.js';
import { requireAdmin, requireTenantScope, signAdmin } from '../middleware/auth.js';
import { encrypt, newApiKey } from '../lib/crypto.js';
import { sha256 } from '../lib/codes.js';
import { getTenant, settingsOf } from '../services/tenants.js';
import { ACTION_TYPES, LABEL, CHANNEL, aiSettings, ist } from '../services/ai/settings.js';
import { planTenant, decide, composeBrief, sendBrief, stats, weeklyReportText } from '../services/ai/index.js';
import { TEMPLATE_PARAMS } from '../services/ai/messaging.js';

/**
 * Bundle B console APIs:
 *   AI Channel Manager   GET /api/admin/ai · POST /ai/plan · POST /ai/brief · POST /ai/actions/:id · PATCH /ai/settings
 *   Korvo link           GET /api/admin/korvo · POST /api/admin/korvo/link   (one-click set-up of both sides)
 *   Sign-in from Korvo   POST /api/auth/hub-sso                              (Korvo app → console, no second password)
 */
const r = Router();
const staff = [requireAdmin('SUPER_ADMIN', 'TENANT_ADMIN', 'TENANT_STAFF'), requireTenantScope];
const adminOnly = [requireAdmin('SUPER_ADMIN', 'TENANT_ADMIN'), requireTenantScope];

// ================= AI Channel Manager =================
r.get('/admin/ai', ...staff, ah(async (req, res) => {
  const tenant = await getTenant(req.tenantId);
  const s = aiSettings(tenant);
  const [{ rows: plan }, { rows: recent }, week, month, { rows: [owed] }, { rows: [korvo30] }] = await Promise.all([
    query(`SELECT a.*, p.name AS p_name, p.mobile AS p_mobile, p.type AS p_type, p.city AS p_city FROM ai_actions a LEFT JOIN participants p ON p.id=a.participant_id
            WHERE a.tenant_id=$1 AND a.status IN ('PROPOSED','APPROVED') ORDER BY a.status, a.brief_item NULLS LAST, a.priority DESC LIMIT 60`, [req.tenantId]),
    query(`SELECT a.*, p.name AS p_name, p.mobile AS p_mobile FROM ai_actions a LEFT JOIN participants p ON p.id=a.participant_id
            WHERE a.tenant_id=$1 AND a.status IN ('DONE','FAILED','SKIPPED','EXECUTING') ORDER BY a.updated_at DESC LIMIT 40`, [req.tenantId]),
    stats(req.tenantId, 7), stats(req.tenantId, 30),
    query(`SELECT coalesce(sum(outstanding_paise),0)::bigint AS outstanding, coalesce(sum(overdue_paise),0)::bigint AS overdue, count(*) FILTER (WHERE overdue_paise > 0)::int AS dealers_overdue, max(as_of) AS as_of FROM dealer_outstanding WHERE tenant_id=$1`, [req.tenantId]),
    query(`SELECT coalesce(sum(CASE WHEN doc_type='CREDIT_NOTE' THEN -total_paise ELSE total_paise END),0)::bigint AS v, count(DISTINCT participant_id)::int AS dealers
             FROM invoices WHERE tenant_id=$1 AND status='PROCESSED' AND source='ROYAL' AND invoice_date > now()::date - 30`, [req.tenantId]),
  ]);
  res.json({
    settings: {
      aiEnabled: s.aiEnabled, aiBriefNumbers: s.aiBriefNumbers, aiBriefHour: s.aiBriefHour, aiContactFromHour: s.aiContactFromHour, aiContactToHour: s.aiContactToHour,
      aiAutonomy: s.autonomy, aiDailyCap: s.aiDailyCap, aiMaxTouchesPerWeek: s.aiMaxTouchesPerWeek, aiReorderMinOrders: s.aiReorderMinOrders,
      aiSlabPushDays: s.aiSlabPushDays, aiSlabPushWithinPct: s.aiSlabPushWithinPct, aiOverdueDays: s.aiOverdueDays, aiOverdueMinRupees: s.aiOverdueMinRupees, aiWinbackMinRupees: s.aiWinbackMinRupees,
    },
    types: ACTION_TYPES.map((t) => ({ type: t, label: LABEL[t].one, channel: CHANNEL[t] })),
    plan, recent, week, month,
    korvo: { linked: !!tenant.korvo?.companyCode, companyCode: tenant.korvo?.companyCode || null, linkedAt: tenant.korvo?.linkedAt || null, ordersPaise30d: Number(korvo30.v), orderingDealers30d: korvo30.dealers, outstandingPaise: Number(owed.outstanding), overduePaise: Number(owed.overdue), dealersOverdue: owed.dealers_overdue, outstandingAsOf: owed.as_of },
    templates: TEMPLATE_PARAMS,
  });
}));

r.post('/admin/ai/plan', ...adminOnly, ah(async (req, res) => {
  const tenant = await getTenant(req.tenantId);
  const planned = await planTenant(tenant);
  const brief = await composeBrief(tenant);
  res.json({ planned: planned.length, waiting: brief.items.length, preview: brief.text });
}));

r.post('/admin/ai/brief', ...adminOnly, ah(async (req, res) => {
  const tenant = await getTenant(req.tenantId);
  if (!aiSettings(tenant).aiBriefNumbers.length) throw badRequest('NO_NUMBERS', 'Add at least one owner mobile number in AI settings first');
  res.json(await sendBrief(tenant));
}));

r.get('/admin/ai/report', ...staff, ah(async (req, res) => res.json(await weeklyReportText(await getTenant(req.tenantId)))));

r.post('/admin/ai/actions/:id', ...adminOnly, ah(async (req, res) => {
  const b = parse(z.object({ decision: z.enum(['approve', 'skip']), text: z.string().max(1000).optional() }), req.body);
  const out = await decide({ tenantId: req.tenantId, actionId: req.params.id, decision: b.decision, text: b.text, by: `console:${req.admin.id}` });
  if (out.error === 'NOT_FOUND') throw notFound('Action');
  if (out.error === 'NOT_PENDING') throw conflict('NOT_PENDING', `Already ${String(out.status).toLowerCase()}`);
  res.json(out);
}));

const LEVEL = z.enum(['SUGGEST', 'APPROVE', 'AUTO']);
r.patch('/admin/ai/settings', ...adminOnly, ah(async (req, res) => {
  const b = parse(z.object({
    aiEnabled: z.boolean().optional(),
    aiBriefNumbers: z.array(z.string().regex(/^\+?\d[\d\s-]{8,16}$/)).max(5).optional(),
    aiBriefHour: z.number().int().min(6).max(12).optional(),
    aiContactFromHour: z.number().int().min(8).max(12).optional(),
    aiContactToHour: z.number().int().min(16).max(21).optional(),
    aiAutonomy: z.record(z.enum(ACTION_TYPES), LEVEL).optional(),
    aiDailyCap: z.number().int().min(1).max(200).optional(),
    aiMaxTouchesPerWeek: z.number().int().min(1).max(5).optional(),
    aiReorderMinOrders: z.number().int().min(2).max(12).optional(),
    aiSlabPushDays: z.number().int().min(1).max(30).optional(),
    aiSlabPushWithinPct: z.number().int().min(5).max(60).optional(),
    aiOverdueDays: z.number().int().min(1).max(180).optional(),
    aiOverdueMinRupees: z.number().int().min(0).optional(),
    aiWinbackMinRupees: z.number().int().min(0).optional(),
  }), req.body);
  if (b.aiAutonomy) for (const t of ['FRAUD_REVIEW', 'SCHEME_IDEA']) if (b.aiAutonomy[t] === 'AUTO') throw badRequest('NOT_ALLOWED', `${LABEL[t].one} always needs a person to approve`);
  const tenant = await getTenant(req.tenantId);
  const settings = { ...(tenant.settings || {}), ...b, ...(b.aiAutonomy ? { aiAutonomy: { ...(tenant.settings?.aiAutonomy || {}), ...b.aiAutonomy } } : {}) };
  await query(`UPDATE tenants SET settings=$2 WHERE id=$1`, [req.tenantId, JSON.stringify(settings)]);
  res.json({ ok: true });
}));

// ================= Korvo link (one platform) =================
r.get('/admin/korvo', ...staff, ah(async (req, res) => {
  const tenant = await getTenant(req.tenantId);
  const { rows: [c] } = await query(`SELECT id, api_key_prefix, last_received_at, config FROM connectors WHERE tenant_id=$1 AND type='ROYAL' AND status='ACTIVE' ORDER BY created_at LIMIT 1`, [req.tenantId]);
  res.json({ linked: !!tenant.korvo?.companyCode, companyCode: tenant.korvo?.companyCode || null, companyName: tenant.korvo?.companyName || null, baseUrl: tenant.korvo?.baseUrl || config.korvo.baseUrl || null, linkedAt: tenant.korvo?.linkedAt || null, connector: c || null, hubConfigured: config.hubSecret.length >= 32, orderDms: settingsOf(tenant).orderDms });
}));

/**
 * One click: create (or re-key) this brand's Korvo connector here, then ask Korvo
 * to switch the link on for the company with this code. Korvo answers with the
 * key Loyvexa uses to send WhatsApp orders. Both sides are wired, nobody copies keys.
 */
r.post('/admin/korvo/link', ...adminOnly, ah(async (req, res) => {
  const b = parse(z.object({ companyCode: z.string().min(2).max(40), korvoBaseUrl: z.string().url().optional(), earnOn: z.enum(['approved', 'delivered']).optional(), active: z.boolean().optional() }), req.body);
  if (config.hubSecret.length < 32) throw badRequest('HUB_NOT_CONFIGURED', 'HUB_SECRET_KORVO is not set on Loyvexa (32+ characters, same value as HUB_SECRET on Korvo)');
  const tenant = await getTenant(req.tenantId);
  const base = (b.korvoBaseUrl || tenant.korvo?.baseUrl || config.korvo.baseUrl || '').replace(/\/$/, '');
  if (!base) throw badRequest('NO_KORVO_URL', 'Korvo URL is missing (KORVO_BASE_URL or korvoBaseUrl)');
  const earnOn = b.earnOn || 'delivered';

  const key = newApiKey('lvx');
  const { rows: [existing] } = await query(`SELECT * FROM connectors WHERE tenant_id=$1 AND type='ROYAL' ORDER BY created_at LIMIT 1`, [req.tenantId]);
  const cfg = { ...(existing?.config || {}), allowTokenExchange: true, earnOn };
  const connector = existing
    ? (await query(`UPDATE connectors SET api_key_hash=$2, api_key_prefix=$3, config=$4, status='ACTIVE' WHERE id=$1 RETURNING *`, [existing.id, sha256(key), key.slice(0, 10), cfg])).rows[0]
    : (await query(`INSERT INTO connectors (tenant_id, type, name, api_key_hash, api_key_prefix, config) VALUES ($1,'ROYAL','Korvo DMS',$2,$3,$4) RETURNING *`, [req.tenantId, sha256(key), key.slice(0, 10), cfg])).rows[0];

  const token = jwt.sign({ purpose: 'provision' }, config.hubSecret, { algorithm: 'HS256', issuer: 'loyvexa', audience: 'korvo', subject: tenant.id, expiresIn: 60, jwtid: crypto.randomBytes(12).toString('hex') });
  let j;
  try {
    const resp = await fetch(`${base}/api/v1/hub/provision`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ companyCode: b.companyCode, tenantSlug: tenant.slug, baseUrl: config.publicBaseUrl, connectorKey: key, earnOn, active: b.active !== false, rotateKey: !tenant.korvo?.apiKeyEnc }),
      signal: AbortSignal.timeout(20000),
    });
    j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw badRequest(j.code || 'KORVO_REFUSED', `Korvo: ${j.message || resp.status}`);
  } catch (e) {
    if (e.status) throw e;
    throw badRequest('KORVO_UNREACHABLE', `Could not reach Korvo at ${base}: ${e.message}`);
  }
  const korvo = {
    ...(tenant.korvo || {}), companyCode: b.companyCode.toUpperCase(), companyId: j.companyId, companyName: j.companyName, baseUrl: base, linkedAt: new Date().toISOString(),
    ...(j.korvoApiKey ? { apiKeyEnc: encrypt(j.korvoApiKey) } : {}),
  };
  const settings = { ...(tenant.settings || {}), orderDms: 'korvo' };
  await query(`UPDATE tenants SET korvo=$2, settings=$3 WHERE id=$1`, [req.tenantId, JSON.stringify(korvo), JSON.stringify(settings)]);
  res.json({ linked: true, companyCode: korvo.companyCode, companyName: korvo.companyName, connectorId: connector.id, ordersGoTo: 'korvo', note: 'Korvo now sends dealers, products, orders and outstanding here nightly; WhatsApp orders go to Korvo for approval.' });
}));

// ================= One-click sign-in from the Korvo app =================
const seen = new Map();
r.post('/auth/hub-sso', ah(async (req, res) => {
  if (config.hubSecret.length < 32) throw forbidden('Sign-in from Korvo is not set up');
  const token = String(req.body?.token || '');
  let c;
  try { c = jwt.verify(token, config.hubSecret, { algorithms: ['HS256'], issuer: 'korvo', audience: 'loyvexa', maxAge: '3m' }); } catch (e) { throw unauthorized(`Sign-in link rejected: ${e.message}`); }
  if (c.purpose !== 'sso' || !c.jti || !c.sub) throw unauthorized('Not a sign-in link');
  const now = Date.now();
  for (const [k, until] of seen) if (until < now) seen.delete(k);
  if (seen.has(c.jti)) throw unauthorized('This sign-in link was already used');
  seen.set(c.jti, c.exp * 1000);

  const { rows: [t] } = await query(`SELECT * FROM tenants WHERE slug=$1 AND status='ACTIVE'`, [c.sub]);
  if (!t || !t.korvo?.companyCode) throw forbidden('This brand is not linked to Korvo');
  const email = String(c.email || '').toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('NO_EMAIL', 'Your Korvo account needs an email address to open the console');
  let { rows: [u] } = await query(`SELECT * FROM admin_users WHERE lower(email)=$1`, [email]);
  // Never hand out a platform (super admin) session, or another brand's.
  if (u && (u.role === 'SUPER_ADMIN' || u.tenant_id !== t.id)) throw forbidden('That email cannot be used to open this brand\'s console');
  if (!u) {
    // A Korvo company admin gets a console login for the same brand.
    ({ rows: [u] } = await query(`INSERT INTO admin_users (tenant_id, email, name, role, password_hash) VALUES ($1,$2,$3,'TENANT_ADMIN',$4) RETURNING *`,
      [t.id, email, String(c.name || email).slice(0, 120), await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10)]));
  }
  if (u.status !== 'ACTIVE') throw forbidden('Your console account is disabled');
  await query(`UPDATE admin_users SET last_login_at=now() WHERE id=$1`, [u.id]);
  res.json({ token: signAdmin(u), user: { id: u.id, name: u.name, email: u.email, role: u.role, tenantId: u.tenant_id } });
}));

export default r;
export { ist };
