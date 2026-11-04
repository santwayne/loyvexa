import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { tx, query } from '../db/pool.js';
import { ah, parse, conflict, unauthorized } from '../lib/errors.js';
import { requireAdmin, signAdmin } from '../middleware/auth.js';

const r = Router();

// Login for every admin type (super admin, brand admin, brand staff)
r.post('/auth/login', ah(async (req, res) => {
  const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
  const { rows: [u] } = await query(`SELECT * FROM admin_users WHERE lower(email)=lower($1)`, [email]);
  if (!u || u.status !== 'ACTIVE' || !(await bcrypt.compare(password, u.password_hash))) throw unauthorized('Wrong email or password');
  await query(`UPDATE admin_users SET last_login_at=now() WHERE id=$1`, [u.id]);
  res.json({ token: signAdmin(u), user: { id: u.id, name: u.name, email: u.email, role: u.role, tenantId: u.tenant_id } });
}));

const tenantSchema = z.object({
  name: z.string().min(2),
  slug: z.string().regex(/^[a-z0-9-]{3,40}$/),
  brandColor: z.string().optional(),
  logoUrl: z.string().url().optional(),
  settings: z.record(z.string(), z.any()).optional(),
  admin: z.object({ name: z.string().min(2), email: z.string().email(), password: z.string().min(8) }),
});

// Onboard a new manufacturer + its first admin (Wayne E Solutions team only)
r.post('/platform/tenants', requireAdmin('SUPER_ADMIN'), ah(async (req, res) => {
  const b = parse(tenantSchema, req.body);
  const out = await tx(async (db) => {
    const { rows: [exists] } = await db.query(`SELECT 1 FROM tenants WHERE slug=$1`, [b.slug]);
    if (exists) throw conflict('SLUG_TAKEN', 'Slug already in use');
    const { rows: [t] } = await db.query(
      `INSERT INTO tenants (name, slug, brand_color, logo_url, settings) VALUES ($1,$2,coalesce($3,'#E85D04'),$4,$5) RETURNING *`,
      [b.name, b.slug, b.brandColor, b.logoUrl, b.settings || {}]);
    const { rows: [u] } = await db.query(
      `INSERT INTO admin_users (tenant_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,'TENANT_ADMIN') RETURNING id, name, email, role`,
      [t.id, b.admin.name, b.admin.email.toLowerCase(), await bcrypt.hash(b.admin.password, 10)]);
    return { tenant: t, admin: u };
  });
  res.status(201).json(out);
}));

r.get('/platform/tenants', requireAdmin('SUPER_ADMIN'), ah(async (req, res) => {
  const { rows } = await query(`
    SELECT t.id, t.name, t.slug, t.status, t.created_at,
      (SELECT count(*) FROM participants p WHERE p.tenant_id=t.id) AS participants,
      (SELECT count(*) FROM qr_codes q WHERE q.tenant_id=t.id AND q.status='SCANNED') AS scans
    FROM tenants t ORDER BY t.created_at DESC`);
  res.json({ tenants: rows });
}));

r.patch('/platform/tenants/:id', requireAdmin('SUPER_ADMIN'), ah(async (req, res) => {
  const b = parse(z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']).optional(), settings: z.record(z.string(), z.any()).optional(), name: z.string().optional() }), req.body);
  const { rows: [t] } = await query(
    `UPDATE tenants SET status=coalesce($2,status), name=coalesce($3,name), settings = settings || coalesce($4,'{}'::jsonb) WHERE id=$1 RETURNING *`,
    [req.params.id, b.status, b.name, b.settings ? JSON.stringify(b.settings) : null]);
  res.json({ tenant: t });
}));

export default r;
