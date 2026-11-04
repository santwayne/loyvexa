import { query } from '../db/pool.js';
import { DEFAULT_TENANT_SETTINGS } from '../config.js';
import { notFound } from '../lib/errors.js';

export const settingsOf = (tenant) => ({ ...DEFAULT_TENANT_SETTINGS, ...(tenant?.settings || {}) });

export async function getTenantBySlug(slug, db = { query }) {
  const { rows } = await db.query(`SELECT * FROM tenants WHERE slug = $1 AND status = 'ACTIVE'`, [slug]);
  if (!rows[0]) throw notFound('Brand');
  return rows[0];
}

export async function getTenant(id, db = { query }) {
  const { rows } = await db.query(`SELECT * FROM tenants WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound('Tenant');
  return rows[0];
}
