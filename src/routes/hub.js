import { Router } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config.js';
import { query, tx } from '../db/pool.js';
import { AppError, ah, forbidden, parse, unauthorized } from '../lib/errors.js';
import { signAdmin } from '../middleware/auth.js';

/**
 * Regulars hub auto-connect (Nov 2026).
 *
 * Regulars (regulars.wayneesolutions.com) is where Wayne E Solutions sells
 * and bills every product. When a client's bundle includes Loyvexa, the hub:
 *
 *   POST /api/hub/provision        creates the brand + its first admin (the owner),
 *                                  or updates it; active=false pauses it
 *   POST /api/hub/sso/exchange     swaps a one-time hub token (from /sso#token=…)
 *                                  for a normal brand-console session
 *
 * Both are authenticated by an HS256 JWT signed with HUB_SECRET:
 *   iss "regulars-hub"  aud "loyvexa"  sub <Regulars business id>
 *   purpose "provision" | "sso"  jti (single use)  exp ≤ 2 minutes
 * Same contract as WayneRing, the CRM, GMB Manager and Video Studio.
 */

const r = Router();

const hubOff = () => new AppError(503, 'HUB_DISABLED', 'Hub connection is not configured (HUB_SECRET)');

/** Verifies a hub token for one purpose and burns its jti. */
export async function verifyHubToken(token, purpose) {
  if (!config.hub.secret || config.hub.secret.length < 32) throw hubOff();
  let claims;
  try {
    claims = jwt.verify(token, config.hub.secret, { algorithms: ['HS256'], issuer: config.hub.issuer, audience: config.hub.audience, maxAge: '3m' });
  } catch {
    throw unauthorized('Invalid or expired hub token');
  }
  if (claims.purpose !== purpose || !claims.sub || !claims.jti) throw unauthorized('Wrong hub token');
  const { rowCount } = await query(`INSERT INTO hub_token_uses (jti, purpose) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [claims.jti, purpose]);
  if (!rowCount) throw unauthorized('Hub token already used');
  // Tokens live 2 minutes; a day of history is plenty to stop a replay.
  query(`DELETE FROM hub_token_uses WHERE used_at < now() - interval '1 day'`).catch(() => {});
  return claims;
}

const bearer = (req) => {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw unauthorized();
  return h.slice(7);
};

/** "Shree Ganesh Auto Parts" → "shree-ganesh-auto-parts" (3–40 chars, like the brand form). */
export function slugBase(name) {
  const s = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34);
  return s.length >= 3 ? s : `brand-${s || 'new'}`.slice(0, 34);
}

async function freeSlug(db, name) {
  const base = slugBase(name);
  for (let i = 0; i < 20; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    const { rows } = await db.query(`SELECT 1 FROM tenants WHERE slug=$1`, [slug]);
    if (!rows.length) return slug;
  }
  return `${base}-${crypto.randomBytes(2).toString('hex')}`;
}

const provisionSchema = z.object({
  hubBusinessId: z.string().min(1),
  active: z.boolean(),
  paidUntil: z.string().nullable().optional(),
  plan: z.string().nullable().optional(),
  business: z.object({
    name: z.string().min(1),
    sector: z.string().optional().nullable(),
    country: z.string().optional().nullable(),
    timezone: z.string().optional().nullable(),
    phone: z.string().optional().nullable(),
  }),
  owner: z.object({ name: z.string().min(1), email: z.string().email(), phone: z.string().optional().nullable() }),
}).passthrough();

r.post('/provision', ah(async (req, res) => {
  const claims = await verifyHubToken(bearer(req), 'provision');
  const b = parse(provisionSchema, req.body);
  if (claims.sub !== b.hubBusinessId) throw unauthorized('Token is for a different business');

  const status = b.active ? 'ACTIVE' : 'SUSPENDED';
  const hubInfo = { businessId: b.hubBusinessId, country: b.business.country ?? null, timezone: b.business.timezone ?? null, paidUntil: b.paidUntil ?? null };

  const out = await tx(async (db) => {
    const { rows: [found] } = await db.query(`SELECT * FROM tenants WHERE hub_business_id=$1 FOR UPDATE`, [b.hubBusinessId]);
    if (found) {
      // Same brand every time. The name/colour/logo stay as the brand team set them.
      const { rows: [t] } = await db.query(
        `UPDATE tenants SET status=$2, settings = settings || jsonb_build_object('hub', $3::jsonb) WHERE id=$1 RETURNING *`,
        [found.id, status, JSON.stringify(hubInfo)]);
      return { tenant: t, created: false };
    }
    const slug = await freeSlug(db, b.business.name);
    const { rows: [t] } = await db.query(
      `INSERT INTO tenants (name, slug, status, hub_business_id, settings) VALUES ($1,$2,$3,$4, jsonb_build_object('hub', $5::jsonb)) RETURNING *`,
      [b.business.name, slug, status, b.hubBusinessId, JSON.stringify(hubInfo)]);
    // First admin = the owner. The hub signs them in, so the password is random;
    // they can set their own later. Emails are unique across Loyvexa: if the
    // owner's email is already used (another brand, a super admin), the admin
    // gets a placeholder login and single sign-on still works.
    const email = b.owner.email.toLowerCase();
    const { rows: [taken] } = await db.query(`SELECT 1 FROM admin_users WHERE lower(email)=$1`, [email]);
    const loginEmail = taken ? `owner+${slug}@hub.loyvexa.invalid` : email;
    const hash = await bcrypt.hash(crypto.randomBytes(24).toString('base64url'), 10);
    await db.query(
      `INSERT INTO admin_users (tenant_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,'TENANT_ADMIN')`,
      [t.id, b.owner.name, loginEmail, hash]);
    return { tenant: t, created: true };
  });

  const t = out.tenant;
  res.json({
    accountId: t.id,
    status: t.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED',
    data: { slug: t.slug, name: t.name, created: out.created, consoleUrl: `${config.publicBaseUrl}/admin/` },
  });
}));

r.post('/sso/exchange', ah(async (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(10) }), req.body);
  const claims = await verifyHubToken(token, 'sso');
  const { rows: [t] } = await query(`SELECT * FROM tenants WHERE hub_business_id=$1`, [claims.sub]);
  if (!t || (claims.acct && claims.acct !== t.id)) throw unauthorized('Brand not found for this business');
  if (t.status !== 'ACTIVE') throw forbidden('This brand is paused. Renew the plan in your Regulars account.');
  // The owner's own admin login if it exists, else the brand's first admin.
  const { rows: [u] } = await query(
    `SELECT * FROM admin_users WHERE tenant_id=$1 AND status='ACTIVE' AND role IN ('TENANT_ADMIN','TENANT_STAFF')
     ORDER BY (lower(email) = lower($2)) DESC, (role = 'TENANT_ADMIN') DESC, created_at ASC LIMIT 1`,
    [t.id, String(claims.email || '')]);
  if (!u) throw forbidden('No active admin for this brand');
  await query(`UPDATE admin_users SET last_login_at=now() WHERE id=$1`, [u.id]);
  const next = typeof claims.next === 'string' && claims.next.startsWith('/') && !claims.next.startsWith('//') ? claims.next : '/admin/';
  res.json({ token: signAdmin(u), user: { id: u.id, name: u.name, email: u.email, role: u.role, tenantId: u.tenant_id }, next });
}));

export default r;
