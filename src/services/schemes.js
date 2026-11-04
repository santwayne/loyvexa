import { tx, query } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { settingsOf, getTenant } from './tenants.js';
import * as ledger from './ledger.js';
import { emit } from './events.js';

/**
 * Slab units: AMOUNT slabs are in RUPEES (min: 100000 = ₹1 lakh), QUANTITY in units, SCANS in scans.
 * rewardType:
 *   FIXED_POINTS – flat points for reaching the slab
 *   PERCENT      – % of net purchase value, paid as points (AMOUNT schemes only)
 *   PER_UNIT     – points per unit / per scan achieved
 * Highest slab reached wins (slabs are not added together).
 */
export function validateScheme(s) {
  const metricFor = { PURCHASE_SLAB: ['AMOUNT', 'QUANTITY'], SCAN_TARGET: ['SCANS'], SCAN_MULTIPLIER: ['SCANS'] };
  if (!metricFor[s.type]?.includes(s.metric)) throw badRequest('INVALID_METRIC', `${s.type} supports metric ${metricFor[s.type]?.join('/')}`);
  if (new Date(s.endsAt) <= new Date(s.startsAt)) throw badRequest('INVALID_DATES', 'End must be after start');
  if (s.type === 'SCAN_MULTIPLIER') {
    if (!(Number(s.multiplier) > 1)) throw badRequest('INVALID_MULTIPLIER', 'Multiplier must be greater than 1 (e.g. 2 = double points)');
    return { ...s, slabs: [] };
  }
  const slabs = [...(s.slabs || [])].sort((a, b) => a.min - b.min);
  if (!slabs.length) throw badRequest('NO_SLABS', 'Add at least one slab');
  for (const sl of slabs) {
    if (!(sl.min > 0) || !(sl.value > 0)) throw badRequest('INVALID_SLAB', 'Each slab needs min > 0 and value > 0');
    if (!['FIXED_POINTS', 'PERCENT', 'PER_UNIT'].includes(sl.rewardType)) throw badRequest('INVALID_SLAB', 'rewardType must be FIXED_POINTS, PERCENT or PER_UNIT');
    if (sl.rewardType === 'PERCENT' && s.metric !== 'AMOUNT') throw badRequest('INVALID_SLAB', 'PERCENT rewards need an AMOUNT scheme');
    if (sl.rewardType === 'PERCENT' && sl.value > 50) throw badRequest('INVALID_SLAB', 'Percent looks too high (max 50%)');
  }
  if (new Set(slabs.map((x) => x.min)).size !== slabs.length) throw badRequest('INVALID_SLAB', 'Two slabs have the same minimum');
  return { ...s, slabs };
}

/** Raw metric per participant. AMOUNT returned in paise. */
export async function computeMetric(db, scheme, participantId = null) {
  const params = [scheme.tenant_id, scheme.starts_at, scheme.ends_at, scheme.eligible_types || [], scheme.product_ids || []];
  let pFilter = '';
  if (participantId) { params.push(participantId); pFilter = `AND pa.id = $${params.length}`; }
  if (scheme.metric === 'SCANS') {
    const { rows } = await db.query(`
      SELECT q.scanned_by AS participant_id, count(*)::numeric AS value
        FROM qr_codes q JOIN participants pa ON pa.id = q.scanned_by
       WHERE q.tenant_id=$1 AND q.status='SCANNED' AND q.scanned_at >= $2 AND q.scanned_at < $3
         AND (cardinality($4::text[]) = 0 OR pa.type = ANY($4::text[]))
         AND (cardinality($5::uuid[]) = 0 OR q.product_id = ANY($5::uuid[])) ${pFilter}
       GROUP BY 1`, params);
    return rows.map((r) => ({ participantId: r.participant_id, value: Number(r.value) }));
  }
  const col = scheme.metric === 'AMOUNT' ? 'l.amount_paise' : 'l.qty';
  // Invoice dates are calendar dates: include every day from start date to end date (IST business days)
  const { rows } = await db.query(`
    SELECT i.participant_id, sum(CASE WHEN i.doc_type='CREDIT_NOTE' THEN -${col} ELSE ${col} END)::numeric AS value
      FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id JOIN participants pa ON pa.id = i.participant_id
     WHERE i.tenant_id=$1 AND i.status='PROCESSED'
       AND i.invoice_date >= ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date
       AND i.invoice_date <= (($3::timestamptz - interval '1 second') AT TIME ZONE 'Asia/Kolkata')::date
       AND (cardinality($4::text[]) = 0 OR pa.type = ANY($4::text[]))
       AND (cardinality($5::uuid[]) = 0 OR l.product_id = ANY($5::uuid[])) ${pFilter}
     GROUP BY 1`, params);
  return rows.map((r) => ({ participantId: r.participant_id, value: Math.max(0, Number(r.value)) }));
}

const display = (scheme, raw) => (scheme.metric === 'AMOUNT' ? raw / 100 : raw); // paise -> rupees for slab comparison

export function evaluate(scheme, raw, settings) {
  const v = display(scheme, raw);
  const slabs = scheme.slabs || [];
  let idx = -1;
  slabs.forEach((s, i) => { if (v >= s.min) idx = i; });
  const pointsFor = (s) => (!s ? 0 : s.rewardType === 'FIXED_POINTS' ? Math.floor(s.value)
    : s.rewardType === 'PERCENT' ? Math.floor((raw * s.value) / 100 / settings.pointValuePaise)
      : Math.floor(v * s.value));
  const next = slabs[idx + 1] || null;
  return {
    value: v, slabIndex: idx >= 0 ? idx : null, slab: idx >= 0 ? slabs[idx] : null, points: pointsFor(slabs[idx]),
    nextSlab: next, remainingToNext: next ? Math.max(0, Math.round((next.min - v) * 100) / 100) : 0,
  };
}

export async function createScheme({ tenantId, adminId, body }) {
  const s = validateScheme(body);
  const { rows: [r] } = await query(
    `INSERT INTO schemes (tenant_id, name, description, type, metric, status, starts_at, ends_at, settle_grace_days, eligible_types, product_ids, slabs, multiplier, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [tenantId, s.name, s.description || null, s.type, s.metric, s.status || 'DRAFT', s.startsAt, s.endsAt, s.settleGraceDays ?? 3,
      s.eligibleTypes || [], s.productIds || [], JSON.stringify(s.slabs), s.multiplier || null, adminId]);
  return r;
}

export async function getScheme(db, tenantId, id) {
  const { rows: [s] } = await db.query(`SELECT * FROM schemes WHERE id=$1 AND tenant_id=$2`, [id, tenantId]);
  if (!s) throw notFound('Scheme');
  return s;
}

export async function leaderboard({ tenantId, schemeId, limit = 100 }) {
  const tenant = await getTenant(tenantId);
  const settings = settingsOf(tenant);
  const scheme = await getScheme({ query }, tenantId, schemeId);
  if (scheme.type === 'SCAN_MULTIPLIER') {
    const { rows } = await query(`
      SELECT l.participant_id, p.name, p.type, p.city, sum(l.points) AS bonus, count(*) AS scans
        FROM ledger_entries l JOIN participants p ON p.id=l.participant_id
       WHERE l.tenant_id=$1 AND l.type='SCHEME_BONUS' AND l.ref_type='scheme_scan' AND l.ref_id LIKE $2
       GROUP BY 1,2,3,4 ORDER BY bonus DESC LIMIT $3`, [tenantId, `${schemeId}:%`, limit]);
    return { scheme, rows };
  }
  const metrics = await computeMetric({ query }, scheme);
  const { rows: people } = metrics.length ? await query(`SELECT id, name, type, city, mobile FROM participants WHERE id = ANY($1::uuid[])`, [metrics.map((m) => m.participantId)]) : { rows: [] };
  const byId = Object.fromEntries(people.map((p) => [p.id, p]));
  const rows = metrics.map((m) => ({ participant: byId[m.participantId], ...evaluate(scheme, m.value, settings) }))
    .sort((a, b) => b.value - a.value).slice(0, limit);
  return { scheme, rows, totals: { participants: metrics.length, qualified: rows.filter((r) => r.slab).length, projectedPoints: rows.reduce((s, r) => s + r.points, 0) } };
}

/** Pay out a finished slab scheme. Idempotent: running twice never pays twice. */
export async function settleScheme({ tenantId, schemeId, force = false }) {
  const tenant = await getTenant(tenantId);
  const settings = settingsOf(tenant);
  return tx(async (db) => {
    const { rows: [scheme] } = await db.query(`SELECT * FROM schemes WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [schemeId, tenantId]);
    if (!scheme) throw notFound('Scheme');
    if (scheme.type === 'SCAN_MULTIPLIER') throw conflict('NOT_SETTLEABLE', 'Multiplier schemes pay instantly on each scan');
    if (scheme.status === 'SETTLED') return { scheme, paid: 0, alreadySettled: true };
    if (scheme.status !== 'ACTIVE') throw conflict('INVALID_STATE', `Scheme is ${scheme.status}`);
    if (new Date(scheme.ends_at) > new Date()) throw conflict('NOT_ENDED', 'Scheme has not ended yet');
    const graceEnd = new Date(new Date(scheme.ends_at).getTime() + scheme.settle_grace_days * 86400000);
    if (!force && graceEnd > new Date()) throw conflict('IN_GRACE_PERIOD', `Waiting for late invoices until ${graceEnd.toISOString().slice(0, 10)} (use force to settle now)`);

    const metrics = await computeMetric(db, scheme);
    let paid = 0; let winners = 0;
    for (const m of metrics) {
      const ev = evaluate(scheme, m.value, settings);
      await db.query(`INSERT INTO scheme_results (scheme_id, participant_id, metric_value, slab_index, points) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [scheme.id, m.participantId, ev.value, ev.slabIndex, ev.points]);
      if (ev.points > 0) {
        await ledger.post(db, { tenantId, participantId: m.participantId, type: 'SCHEME_BONUS', points: ev.points, refType: 'scheme', refId: `${scheme.id}:${m.participantId}`, note: `${scheme.name}${ev.slab?.label ? ` · ${ev.slab.label}` : ''}` });
        await emit(db, tenantId, 'scheme.bonus', { schemeId: scheme.id, schemeName: scheme.name, participantId: m.participantId, points: ev.points, value: ev.value, metric: scheme.metric });
        paid += ev.points; winners++;
      }
    }
    const { rows: [u] } = await db.query(`UPDATE schemes SET status='SETTLED', settled_at=now() WHERE id=$1 RETURNING *`, [scheme.id]);
    return { scheme: u, participants: metrics.length, winners, paid };
  });
}

/** Instant bonus on a scan if a SCAN_MULTIPLIER scheme is running. Called inside the scan tx. */
export async function applyScanMultiplier(db, { tenantId, participant, qr, basePoints }) {
  if (basePoints <= 0) return null;
  const { rows: [s] } = await db.query(`
    SELECT * FROM schemes WHERE tenant_id=$1 AND type='SCAN_MULTIPLIER' AND status='ACTIVE' AND now() >= starts_at AND now() < ends_at
       AND (cardinality(eligible_types)=0 OR $2 = ANY(eligible_types)) AND (cardinality(product_ids)=0 OR $3 = ANY(product_ids))
     ORDER BY multiplier DESC LIMIT 1`, [tenantId, participant.type, qr.product_id]);
  if (!s) return null;
  const bonus = Math.floor(basePoints * (Number(s.multiplier) - 1));
  if (bonus <= 0) return null;
  await ledger.post(db, { tenantId, participantId: participant.id, type: 'SCHEME_BONUS', points: bonus, refType: 'scheme_scan', refId: `${s.id}:${qr.id}`, note: `${s.name} (${Number(s.multiplier)}x)` });
  return { schemeId: s.id, name: s.name, bonus, multiplier: Number(s.multiplier) };
}

/** Active schemes this participant can take part in, with live progress. */
export async function progressFor({ tenant, participant }) {
  const settings = settingsOf(tenant);
  const { rows: schemes } = await query(`
    SELECT * FROM schemes WHERE tenant_id=$1 AND status='ACTIVE' AND now() < ends_at + make_interval(days => settle_grace_days)
       AND (cardinality(eligible_types)=0 OR $2 = ANY(eligible_types)) ORDER BY ends_at`, [tenant.id, participant.type]);
  const out = [];
  for (const s of schemes) {
    // Scan schemes with no explicit audience are for people who scan (not dealers/distributors)
    if (s.type !== 'PURCHASE_SLAB' && !(s.eligible_types || []).length && ['DEALER', 'DISTRIBUTOR'].includes(participant.type)) continue;
    const base = { id: s.id, name: s.name, description: s.description, type: s.type, metric: s.metric, startsAt: s.starts_at, endsAt: s.ends_at, slabs: s.slabs, multiplier: s.multiplier ? Number(s.multiplier) : null, upcoming: new Date(s.starts_at) > new Date() };
    if (s.type === 'SCAN_MULTIPLIER') { out.push(base); continue; }
    const [m] = await computeMetric({ query }, s, participant.id);
    out.push({ ...base, progress: evaluate(s, m?.value || 0, settings) });
  }
  return out;
}

/** Called by the worker: settle schemes whose grace period is over. */
export async function autoSettleDue() {
  const { rows } = await query(`SELECT id, tenant_id FROM schemes WHERE status='ACTIVE' AND type <> 'SCAN_MULTIPLIER' AND ends_at + make_interval(days => settle_grace_days) <= now()`);
  const results = [];
  for (const r of rows) {
    try { results.push(await settleScheme({ tenantId: r.tenant_id, schemeId: r.id })); } catch (e) { results.push({ schemeId: r.id, error: e.message }); }
  }
  // Multiplier schemes simply end
  await query(`UPDATE schemes SET status='SETTLED', settled_at=now() WHERE status='ACTIVE' AND type='SCAN_MULTIPLIER' AND ends_at <= now()`);
  return results;
}
