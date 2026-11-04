import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { unauthorized, forbidden } from '../lib/errors.js';

export const signAdmin = (u) => jwt.sign({ kind: 'admin', sub: u.id, role: u.role, tenantId: u.tenant_id }, config.jwtSecret, { expiresIn: config.adminTokenTtl });
export const signParticipant = (p) => jwt.sign({ kind: 'participant', sub: p.id, tenantId: p.tenant_id }, config.jwtSecret, { expiresIn: config.participantTokenTtl });

function bearer(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw unauthorized();
  try { return jwt.verify(h.slice(7), config.jwtSecret); } catch { throw unauthorized('Invalid or expired token'); }
}

/** Admin auth. Super admins may act on any tenant via ?tenantId= or X-Tenant-Id. */
export const requireAdmin = (...roles) => async (req, res, next) => {
  try {
    const t = bearer(req);
    if (t.kind !== 'admin') throw unauthorized();
    const { rows: [u] } = await query(`SELECT id, tenant_id, role, name, email, status FROM admin_users WHERE id=$1`, [t.sub]);
    if (!u || u.status !== 'ACTIVE') throw unauthorized();
    if (roles.length && !roles.includes(u.role)) throw forbidden();
    req.admin = u;
    req.tenantId = u.role === 'SUPER_ADMIN' ? (req.headers['x-tenant-id'] || req.query.tenantId || null) : u.tenant_id;
    next();
  } catch (e) { next(e); }
};

export const requireTenantScope = (req, res, next) => (req.tenantId ? next() : next(forbidden('Tenant scope required (X-Tenant-Id)')));

export const requireParticipant = async (req, res, next) => {
  try {
    const t = bearer(req);
    if (t.kind !== 'participant') throw unauthorized();
    const { rows: [p] } = await query(
      `SELECT p.*, row_to_json(t.*) AS tenant FROM participants p JOIN tenants t ON t.id = p.tenant_id WHERE p.id = $1`, [t.sub]);
    if (!p) throw unauthorized();
    if (p.tenant.status !== 'ACTIVE') throw forbidden('Programme is paused');
    req.participant = p;
    req.tenant = p.tenant;
    next();
  } catch (e) { next(e); }
};
