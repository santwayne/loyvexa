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
  const params = [tenantId, segments, types];
  let where = `p.tenant_id=$1 AND p.status='ACTIVE' AND (cardinality($2::text[])=0 OR p.segment = ANY($2::text[])) AND (cardinality($3::text[])=0 OR p.type = ANY($3::text[]))`;
  if (city) { params.push(city); where += ` AND lower(p.city)=lower($${params.length})`; }
  if (schemeId) {
    params.push(schemeId);
    where += ` AND EXISTS (SELECT 1 FROM schemes s WHERE s.id=$${params.length} AND (cardinality(s.eligible_types)=0 OR p.type = ANY(s.eligible_types)))`;
  }
  const { rows } = await db.query(`SELECT p.* FROM participants p WHERE ${where} ${extraWhere} ORDER BY p.created_at`, params);
  return rows;
}
