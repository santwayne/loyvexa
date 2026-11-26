import { canonicalCity, tidyCity } from '../lib/cities.js';
import { query, tx } from '../db/pool.js';
import { settingsOf } from './tenants.js';
import { emit } from './events.js';

/**
 * Behavioural segments (same model as Regulars), per participant:
 *   NEW          joined within segNewDays
 *   DORMANT      no activity for segDormantDays (or never active after the NEW window)
 *   AT_RISK      no activity for segAtRiskDays
 *   HIGH_SPENDER active and earned >= segHighValuePoints90d in the last 90 days
 *   REGULAR      everyone else who is active
 * Activity = last scan (mechanics, retailers) or last purchase invoice (dealers), whichever is later.
 * `asOf` lets tests and back-fills evaluate as of another date.
 */
export const SEGMENTS = ['NEW', 'REGULAR', 'AT_RISK', 'DORMANT', 'HIGH_SPENDER'];
const DAY = 86400000;

export function classify({ createdAt, lastActivity, earned90 }, s, asOf) {
  const now = asOf.getTime();
  if (now - new Date(createdAt).getTime() < s.segNewDays * DAY) return 'NEW';
  if (!lastActivity) return 'DORMANT';
  const idle = (now - new Date(lastActivity).getTime()) / DAY;
  if (idle >= s.segDormantDays) return 'DORMANT';
  if (idle >= s.segAtRiskDays) return 'AT_RISK';
  if (earned90 >= s.segHighValuePoints90d) return 'HIGH_SPENDER';
  return 'REGULAR';
}

export async function recomputeTenant(tenant, asOf = new Date()) {
  const s = settingsOf(tenant);
  const { rows } = await query(`
    SELECT p.id, p.segment, p.created_at,
           NULLIF(GREATEST(coalesce(p.last_scan_at, '-infinity'), coalesce(p.last_purchase_at, '-infinity')), '-infinity') AS last_activity,
           coalesce((SELECT sum(points) FROM ledger_entries l WHERE l.participant_id=p.id AND l.points > 0
                       AND l.type IN ('EARN_SCAN','PURCHASE_EARN','SCHEME_BONUS','BONUS')
                       AND l.created_at > $2::timestamptz - interval '90 days' AND l.created_at <= $2::timestamptz), 0) AS earned90
      FROM participants p WHERE p.tenant_id=$1 AND p.status='ACTIVE'`, [tenant.id, asOf.toISOString()]);
  const counts = Object.fromEntries(SEGMENTS.map((k) => [k, 0]));
  let changed = 0;
  for (const r of rows) {
    const seg = classify({ createdAt: r.created_at, lastActivity: r.last_activity, earned90: Number(r.earned90) }, s, asOf);
    counts[seg]++;
    if (seg === r.segment) continue;
    changed++;
    await tx(async (db) => {
      await db.query(`UPDATE participants SET segment=$2, segment_changed_at=$3 WHERE id=$1`, [r.id, seg, asOf.toISOString()]);
      await db.query(`INSERT INTO participant_segments (tenant_id, participant_id, segment, previous, computed_at) VALUES ($1,$2,$3,$4,$5)`, [tenant.id, r.id, seg, r.segment, asOf.toISOString()]);
      await emit(db, tenant.id, 'segment.changed', { participantId: r.id, from: r.segment, to: seg });
    });
  }
  return { evaluated: rows.length, changed, counts };
}

export async function recomputeAll(asOf = new Date()) {
  const { rows } = await query(`SELECT * FROM tenants WHERE status='ACTIVE'`);
  const out = {};
  for (const t of rows) out[t.slug] = await recomputeTenant(t, asOf);
  return out;
}

/** Shared audience filter for call + WhatsApp campaigns. Returns participant rows. */
export async function audience(db, { tenantId, segments = [], types = [], city = null, schemeId = null, extraWhere = '' }) {
  // Testing report #4: never filter on a segment that was never computed (worker not run yet / not running).
  if (segments.length) {
    const { rows: [u] } = await db.query(`SELECT count(*)::int AS n FROM participants WHERE tenant_id=$1 AND status='ACTIVE' AND segment IS NULL`, [tenantId]);
    if (u.n) {
      const { rows: [t] } = await db.query(`SELECT * FROM tenants WHERE id=$1`, [tenantId]);
      await recomputeTenant(t);
    }
  }
  const params = [tenantId, segments, types];
  let where = `p.tenant_id=$1 AND p.status='ACTIVE' AND (cardinality($2::text[])=0 OR p.segment = ANY($2::text[])) AND (cardinality($3::text[])=0 OR p.type = ANY($3::text[]))`;
  if (city && city.trim()) { params.push(city.trim()); where += ` AND lower(btrim(p.city))=lower($${params.length})`; }
  if (schemeId) {
    params.push(schemeId);
    where += ` AND EXISTS (SELECT 1 FROM schemes s WHERE s.id=$${params.length} AND (cardinality(s.eligible_types)=0 OR p.type = ANY(s.eligible_types)))`;
  }
  const { rows } = await db.query(`SELECT p.* FROM participants p WHERE ${where} ${extraWhere} ORDER BY p.created_at`, params);
  return rows;
}

/**
 * Testing report #4/#5: before launching, show how many people match and — when it's 0 —
 * which filter knocked everyone out, plus the cities that do exist (catches "Ludhiana" vs "Ludihiana").
 */
export async function audiencePreview(db, { tenantId, segments = [], types = [], city = null, schemeId = null }) {
  const people = await audience(db, { tenantId, segments, types, city, schemeId });
  const out = { count: people.length, sample: people.slice(0, 5).map((p) => ({ name: p.name, type: p.type, city: p.city, segment: p.segment })) };
  out.dnd = people.filter((p) => p.dnd).length;
  if (people.length) return out;
  const n = async (args) => (await audience(db, { tenantId, ...args })).length;
  const [all, bySeg, byType, byCity, unscored] = await Promise.all([
    n({}), segments.length ? n({ segments }) : null, types.length ? n({ types }) : null, city ? n({ city }) : null,
    db.query(`SELECT count(*)::int AS n FROM participants WHERE tenant_id=$1 AND status='ACTIVE' AND segment IS NULL`, [tenantId]).then((r) => r.rows[0].n),
  ]);
  const reasons = [];
  if (!all) reasons.push('There are no active participants in this brand yet.');
  if (bySeg === 0) reasons.push(`Nobody is in segment ${segments.join(' / ')}.${unscored ? ` ${unscored} participant(s) have no segment yet — press "Recompute" on the Segments page.` : ''}`);
  if (byType === 0) reasons.push(`Nobody is of type ${types.join(' / ')}.`);
  if (byCity === 0) reasons.push(`Nobody has city "${city}".`);
  if (!reasons.length) reasons.push('Each filter matches someone, but no one matches all of them together.');
  out.reasons = reasons;
  if (city) {
    const { rows } = await db.query(`SELECT city, count(*)::int AS n FROM participants WHERE tenant_id=$1 AND status='ACTIVE' AND city IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, [tenantId]);
    out.cities = rows;
  }
  return out;
}

/** Known cities of a brand, for the city dropdowns (one spelling each — testing report 2 #10). */
export async function citiesOf(tenantId) {
  const { rows } = await query(`SELECT city, count(*)::int AS n FROM participants WHERE tenant_id=$1 AND city IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 100`, [tenantId]);
  const { rows: [t] } = await query(`SELECT settings FROM tenants WHERE id=$1`, [tenantId]);
  const extra = Array.isArray(t?.settings?.cities) ? t.settings.cities.map(tidyCity).filter(Boolean) : [];
  return [...new Set([...rows.map((r) => r.city), ...extra])];
}

/** Brand-specific spellings to trust: settings.cities + existing cities that aren't a typo of a common city. */
async function trustedCities(tenantId) {
  const { rows: [t] } = await query(`SELECT settings FROM tenants WHERE id=$1`, [tenantId]);
  const extra = Array.isArray(t?.settings?.cities) ? t.settings.cities : [];
  const { rows } = await query(`SELECT DISTINCT city FROM participants WHERE tenant_id=$1 AND city IS NOT NULL`, [tenantId]);
  return [...extra, ...rows.map((r) => r.city).filter((c) => canonicalCity(c, extra) === tidyCity(c))];
}

/** The one spelling to store for a typed city ("Ludihiana" → "Ludhiana"). */
export async function cityFor(tenantId, input) {
  if (!input || !String(input).trim()) return null;
  return canonicalCity(input, await trustedCities(tenantId));
}

/** Re-spell existing rows ("Ludihiana" → "Ludhiana"). Safe to run any time. */
export async function fixCities(tenantId) {
  const where = tenantId ? 'WHERE tenant_id=$1' : '';
  const { rows } = await query(`SELECT DISTINCT tenant_id, city FROM participants ${where ? `${where} AND` : 'WHERE'} city IS NOT NULL`, tenantId ? [tenantId] : []);
  let fixed = 0;
  const trusted = {};
  for (const r of rows) {
    trusted[r.tenant_id] ||= await query(`SELECT settings FROM tenants WHERE id=$1`, [r.tenant_id]).then(({ rows: [t] }) => (Array.isArray(t?.settings?.cities) ? t.settings.cities : []));
    const c = canonicalCity(r.city, trusted[r.tenant_id]);
    if (c && c !== r.city) fixed += (await query(`UPDATE participants SET city=$3 WHERE tenant_id=$1 AND city=$2`, [r.tenant_id, r.city, c])).rowCount;
  }
  return fixed;
}
