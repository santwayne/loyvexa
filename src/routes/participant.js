import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query, tx } from '../db/pool.js';
import { ah, parse, badRequest, forbidden } from '../lib/errors.js';
import { normalizeMobile } from '../lib/codes.js';
import { requireParticipant, signParticipant } from '../middleware/auth.js';
import { getTenantBySlug, settingsOf } from '../services/tenants.js';
import { requestOtp, verifyOtp } from '../services/otp.js';
import { scan } from '../services/scan.js';
import * as ledger from '../services/ledger.js';
import { requestRedemption, isValidUpi } from '../services/redemption.js';
import { emit } from '../services/events.js';
import { config } from '../config.js';
import { progressFor } from '../services/schemes.js';

const r = Router();
const otpLimiter = rateLimit({ windowMs: 60_000, limit: config.otpRateLimitPerMinute, standardHeaders: true, legacyHeaders: false });

const publicTenant = (t) => ({ name: t.name, slug: t.slug, brandColor: t.brand_color, logoUrl: t.logo_url });

// Brand info for the PWA splash/login screen
r.get('/:slug/info', ah(async (req, res) => {
  const t = await getTenantBySlug(req.params.slug);
  const s = settingsOf(t);
  res.json({ brand: publicTenant(t), signupTypes: s.allowSelfSignup ? s.selfSignupTypes : [], pointValuePaise: s.pointValuePaise, minRedeemPoints: s.minRedeemPoints });
}));

r.post('/:slug/auth/otp/request', otpLimiter, ah(async (req, res) => {
  const t = await getTenantBySlug(req.params.slug);
  const mobile = normalizeMobile(req.body?.mobile);
  if (!mobile) throw badRequest('INVALID_MOBILE', 'Enter a valid mobile number');
  res.json(await requestOtp({ tenantId: t.id, mobile }));
}));

r.post('/:slug/auth/otp/verify', otpLimiter, ah(async (req, res) => {
  const t = await getTenantBySlug(req.params.slug);
  const s = settingsOf(t);
  const b = parse(z.object({ mobile: z.string(), otp: z.string().min(4).max(8), name: z.string().optional(), type: z.string().optional(), city: z.string().optional() }), req.body);
  const mobile = normalizeMobile(b.mobile);
  if (!mobile) throw badRequest('INVALID_MOBILE', 'Enter a valid mobile number');
  await verifyOtp({ tenantId: t.id, mobile, code: b.otp });

  const { rows: [existing] } = await query(`SELECT * FROM participants WHERE tenant_id=$1 AND mobile=$2`, [t.id, mobile]);
  if (existing) return res.json({ token: signParticipant(existing), isNew: false });

  if (!s.allowSelfSignup) throw forbidden('Registration is by invitation. Contact your dealer or the brand.');
  const type = s.selfSignupTypes.includes(b.type) ? b.type : s.selfSignupTypes[0];
  const p = await tx(async (db) => {
    const { rows: [p] } = await db.query(
      `INSERT INTO participants (tenant_id, type, name, mobile, city) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, mobile) DO UPDATE SET mobile=EXCLUDED.mobile RETURNING *`,
      [t.id, type, b.name || null, mobile, b.city || null]);
    await db.query(`INSERT INTO wallets (participant_id, tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [p.id, t.id]);
    await emit(db, t.id, 'participant.created', { participantId: p.id, type: p.type, source: 'self_signup' });
    return p;
  });
  res.status(201).json({ token: signParticipant(p), isNew: true });
}));

// ---- Authenticated participant ----
r.use(requireParticipant);

const me = (p) => ({ id: p.id, type: p.type, name: p.name, mobile: p.mobile, city: p.city, state: p.state, pincode: p.pincode, upiId: p.upi_id, language: p.language, status: p.status });

r.get('/me', ah(async (req, res) => {
  const s = settingsOf(req.tenant);
  const wallet = await ledger.getWallet({ query }, req.participant.id);
  res.json({
    participant: me(req.participant), brand: publicTenant(req.tenant), wallet,
    rupeeValue: (wallet.balance * s.pointValuePaise) / 100, minRedeemPoints: s.minRedeemPoints, pointValuePaise: s.pointValuePaise,
  });
}));

r.patch('/me', ah(async (req, res) => {
  const b = parse(z.object({ name: z.string().min(1).optional(), city: z.string().optional(), state: z.string().optional(), pincode: z.string().optional(), upiId: z.string().optional(), language: z.enum(['hi', 'en', 'pa']).optional() }), req.body);
  if (b.upiId && !isValidUpi(b.upiId)) throw badRequest('INVALID_UPI', 'Invalid UPI ID (example: name@okaxis)');
  const { rows: [p] } = await query(
    `UPDATE participants SET name=coalesce($2,name), city=coalesce($3,city), state=coalesce($4,state), pincode=coalesce($5,pincode),
       upi_id=coalesce($6,upi_id), language=coalesce($7,language) WHERE id=$1 RETURNING *`,
    [req.participant.id, b.name, b.city, b.state, b.pincode, b.upiId, b.language]);
  res.json({ participant: me(p) });
}));

r.post('/scan', ah(async (req, res) => {
  const b = parse(z.object({ code: z.string().min(4).max(300), lat: z.number().optional(), lng: z.number().optional() }), req.body);
  const out = await scan({
    tenant: req.tenant, participantId: req.participant.id, input: b.code, lat: b.lat ?? null, lng: b.lng ?? null,
    deviceId: req.headers['x-device-id']?.toString().slice(0, 100) || null, ip: req.ip,
  });
  res.status(out.ok ? 200 : 422).json(out);
}));

r.get('/schemes', ah(async (req, res) => {
  res.json({ schemes: await progressFor({ tenant: req.tenant, participant: req.participant }) });
}));

r.get('/ledger', ah(async (req, res) => {
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const { rows } = await query(
    `SELECT id, type, points, balance_after, note, created_at FROM ledger_entries WHERE participant_id=$1 AND id < $2 ORDER BY id DESC LIMIT 50`,
    [req.participant.id, before]);
  res.json({ entries: rows });
}));

r.post('/redeem', ah(async (req, res) => {
  const { points } = parse(z.object({ points: z.number().int().positive() }), req.body);
  const redemption = await requestRedemption({ tenant: req.tenant, participantId: req.participant.id, points });
  res.status(201).json({ redemption });
}));

r.get('/redemptions', ah(async (req, res) => {
  const { rows } = await query(`SELECT id, points, amount_paise, upi_id, status, failure_reason, created_at, updated_at FROM redemptions WHERE participant_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.participant.id]);
  res.json({ redemptions: rows });
}));

export default r;
