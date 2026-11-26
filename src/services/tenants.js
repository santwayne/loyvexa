import { query } from '../db/pool.js';
import { DEFAULT_TENANT_SETTINGS } from '../config.js';
import { notFound } from '../lib/errors.js';

// null / empty values saved earlier must not wipe out the defaults (testing report #3: blank AI fields)
const present = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== null && v !== undefined && !(typeof v === 'number' && Number.isNaN(v))));
export const settingsOf = (tenant) => ({ ...DEFAULT_TENANT_SETTINGS, ...present(tenant?.settings) });

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
