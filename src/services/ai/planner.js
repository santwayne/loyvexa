import { query } from '../../db/pool.js';
import { computeMetric, evaluate, progressFor } from '../schemes.js';
import * as ledger from '../ledger.js';
import { canOrder } from '../orders.js';
import {
  ACTION_TYPES, BASE_WIN_RATE, CHANNEL, DAY, aiSettings, ist, isoWeek, rupee, shortDate,
} from './settings.js';

/**
 * The planner: finds candidate actions, ranks them by expected value × the
 * brand's own learned win rate, applies the guardrails and saves the plan.
 * Nothing here contacts anyone — that is the executor's job, after approval.
 */
const PURCHASE_TYPES = ['DEALER', 'DISTRIBUTOR', 'RETAILER'];
const daysBetween = (a, b) => Math.floor((new Date(b).getTime() - new Date(a).getTime()) / DAY);
const hi = (p) => p.language !== 'en';
const first = (p) => (p.name || '').split(' ')[0] || '';

/** Learned win rates: the brand's own results, blended with a starting guess. */
export async function winRates(tenantId) {
  const { rows } = await query(`
    SELECT type, count(*) FILTER (WHERE outcome='WON')::int AS won, count(*)::int AS n
      FROM ai_actions WHERE tenant_id=$1 AND outcome IS NOT NULL AND executed_at > now() - interval '90 days' GROUP BY 1`, [tenantId]);
  const out = { ...BASE_WIN_RATE };
  for (const r of rows) out[r.type] = (r.won + BASE_WIN_RATE[r.type] * 5) / (r.n + 5);
  return out;
}

// ── (a) Reorder due: each dealer's own buying rhythm ─────────────────────
async function reorderCandidates(tenant, s, today) {
  const types = s.purchaseEarnTypes?.length ? s.purchaseEarnTypes : PURCHASE_TYPES;
  const { rows } = await query(`
    WITH inv AS (
      SELECT i.participant_id, i.invoice_date, i.total_paise,
             lag(i.invoice_date) OVER (PARTITION BY i.participant_id ORDER BY i.invoice_date) AS prev
        FROM invoices i JOIN participants p ON p.id=i.participant_id
       WHERE i.tenant_id=$1 AND i.status='PROCESSED' AND i.doc_type='INVOICE' AND p.status='ACTIVE' AND p.type = ANY($3::text[])
         AND i.invoice_date > $2::date - 365
    )
    SELECT participant_id, count(*)::int AS n, max(invoice_date) AS last_date,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY (invoice_date - prev)) FILTER (WHERE prev IS NOT NULL AND invoice_date > prev) AS gap,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY total_paise) AS value
      FROM inv GROUP BY 1 HAVING count(*) >= $4`, [tenant.id, today, types, s.aiReorderMinOrders]);
  const out = [];
  for (const r of rows) {
    const gap = Number(r.gap);
    if (!(gap >= 3)) continue;
    const since = daysBetween(r.last_date, today);
    if (since < Math.round(gap) || since >= gap * 2.5) continue; // not due yet / gone quiet (win-back territory)
    const { rows: basket } = await query(`
      SELECT l.sku, coalesce(pr.name, l.item_name) AS name, sum(l.qty)::numeric AS qty, (pr.price_paise IS NOT NULL AND pr.active) AS orderable
        FROM invoices i JOIN invoice_lines l ON l.invoice_id=i.id LEFT JOIN products pr ON pr.tenant_id=i.tenant_id AND pr.sku=l.sku
       WHERE i.participant_id=$1 AND i.status='PROCESSED' AND i.doc_type='INVOICE' AND i.invoice_date=$2
       GROUP BY 1,2,4 ORDER BY sum(l.amount_paise) DESC LIMIT 8`, [r.participant_id, r.last_date]);
    out.push({
      type: 'REORDER_NUDGE', participantId: r.participant_id, expected: Math.round(Number(r.value)),
      dedupe: `REORDER:${r.participant_id}:${new Date(r.last_date).toISOString().slice(0, 10)}`,
      facts: { gapDays: Math.round(gap), sinceDays: since, lastDate: r.last_date, orders: r.n, basket: basket.map((b) => ({ sku: b.sku, name: b.name, qty: Number(b.qty), orderable: !!b.orderable })) },
    });
  }
  return out;
}

// ── (b) Big dealers who went quiet → AI call ─────────────────────────────
async function winbackCandidates(tenant, s, today) {
  const types = s.purchaseEarnTypes?.length ? s.purchaseEarnTypes : PURCHASE_TYPES;
  const { rows } = await query(`
    SELECT p.id, p.last_purchase_at,
           coalesce((SELECT sum(CASE WHEN i.doc_type='CREDIT_NOTE' THEN -i.total_paise ELSE i.total_paise END) FROM invoices i
                      WHERE i.participant_id=p.id AND i.status='PROCESSED' AND i.invoice_date > p.last_purchase_at::date - 180), 0)::bigint AS bought180
      FROM participants p
     WHERE p.tenant_id=$1 AND p.status='ACTIVE' AND NOT p.dnd AND p.type = ANY($2::text[]) AND p.last_purchase_at IS NOT NULL
       AND p.last_purchase_at < $3::date - make_interval(days => $4) AND p.last_purchase_at > $3::date - 120`,
  [tenant.id, types, today, s.segAtRiskDays]);
  return rows.filter((r) => Number(r.bought180) >= s.aiWinbackMinRupees * 100).map((r) => ({
    type: 'WINBACK_CALL', participantId: r.id, expected: Math.round(Number(r.bought180) / 6),
    dedupe: `WINBACK:${r.id}:${today.slice(0, 7)}`,
    facts: { quietDays: daysBetween(r.last_purchase_at, today), bought180: Number(r.bought180) },
  }));
}

// ── (c) Close to the next slab, scheme ending soon ───────────────────────
async function slabCandidates(tenant, s, today, now) {
  const { rows: schemes } = await query(`
    SELECT * FROM schemes WHERE tenant_id=$1 AND status='ACTIVE' AND type IN ('PURCHASE_SLAB','SCAN_TARGET')
       AND starts_at <= $2 AND ends_at > $2 AND ends_at <= $2::timestamptz + make_interval(days => $3)`, [tenant.id, now, s.aiSlabPushDays]);
  const out = [];
  for (const sc of schemes) {
    for (const m of await computeMetric({ query }, sc)) {
      const e = evaluate(sc, m.value, s);
      if (!e.nextSlab || !(e.remainingToNext > 0) || e.remainingToNext > (e.nextSlab.min * s.aiSlabPushWithinPct) / 100) continue;
      const nextIdx = (e.slabIndex ?? -1) + 1;
      const reward = e.nextSlab.rewardType === 'PERCENT' ? `${e.nextSlab.value}% bonus` : e.nextSlab.rewardType === 'PER_UNIT' ? `${e.nextSlab.value} points/unit` : `${Number(e.nextSlab.value).toLocaleString('en-IN')} points`;
      out.push({
        type: 'SLAB_PUSH', participantId: m.participantId,
        expected: sc.metric === 'AMOUNT' ? Math.round(e.remainingToNext * 100) : Math.round(Number(e.nextSlab.value || 0) * s.pointValuePaise),
        dedupe: `SLAB:${sc.id}:${m.participantId}:${nextIdx}`,
        facts: { schemeId: sc.id, scheme: sc.name, metric: sc.metric, value: e.value, remaining: e.remainingToNext, nextMin: e.nextSlab.min, reward, endsAt: sc.ends_at, daysLeft: Math.max(0, Math.ceil((new Date(sc.ends_at) - now) / DAY)) },
      });
    }
  }
  return out;
}

// ── (d) Mechanics who stopped scanning ───────────────────────────────────
async function mechanicCandidates(tenant, s, today) {
  const { rows } = await query(`
    SELECT p.id, p.last_scan_at,
           coalesce((SELECT sum(points) FROM ledger_entries l WHERE l.participant_id=p.id AND l.type IN ('EARN_SCAN','SCHEME_BONUS')
                      AND l.points > 0 AND l.created_at > p.last_scan_at - interval '90 days'), 0)::bigint AS earned90
      FROM participants p
     WHERE p.tenant_id=$1 AND p.status='ACTIVE' AND NOT p.wa_opt_out AND p.segment='AT_RISK'
       AND NOT (p.type = ANY($2::text[])) AND p.last_scan_at IS NOT NULL`, [tenant.id, PURCHASE_TYPES]);
  return rows.filter((r) => Number(r.earned90) > 0).map((r) => ({
    type: 'MECHANIC_NUDGE', participantId: r.id, expected: Math.round((Number(r.earned90) / 3) * s.pointValuePaise),
    dedupe: `MECH:${r.id}:${today.slice(0, 7)}`,
    facts: { quietDays: daysBetween(r.last_scan_at, today), monthlyPoints: Math.round(Number(r.earned90) / 3) },
  }));
}

// ── (e) Overdue payments (from Korvo / Tally) ────────────────────────────
async function paymentCandidates(tenant, s, today) {
  const { rows } = await query(`
    SELECT o.* FROM dealer_outstanding o JOIN participants p ON p.id=o.participant_id
     WHERE o.tenant_id=$1 AND p.status='ACTIVE' AND o.overdue_paise >= $2 AND o.days_overdue >= $3`,
  [tenant.id, s.aiOverdueMinRupees * 100, s.aiOverdueDays]);
  return rows.map((r) => ({
    type: 'PAYMENT_REMINDER', participantId: r.participant_id, expected: Number(r.overdue_paise),
    dedupe: `PAY:${r.participant_id}:${isoWeek(new Date(`${today}T00:00:00Z`))}`,
    facts: { overduePaise: Number(r.overdue_paise), outstandingPaise: Number(r.outstanding_paise), daysOverdue: r.days_overdue, oldestDue: r.oldest_due_date },
  }));
}

// ── (f) Fraud: repeated flags with money waiting to be paid ──────────────
async function fraudCandidates(tenant, s) {
  const { rows } = await query(`
    SELECT p.id, count(DISTINCT f.id)::int AS flags, max(f.id::text) AS last_flag, array_agg(DISTINCT f.rule) AS rules,
           (SELECT coalesce(sum(r.points),0) FROM redemptions r WHERE r.participant_id=p.id AND r.status IN ('REQUESTED','PROCESSING'))::bigint AS pending
      FROM participants p JOIN fraud_flags f ON f.participant_id=p.id AND f.status='OPEN' AND f.created_at > now() - interval '7 days'
     WHERE p.tenant_id=$1 AND p.status='ACTIVE' GROUP BY p.id HAVING count(DISTINCT f.id) >= 2`, [tenant.id]);
  return rows.filter((r) => Number(r.pending) > 0).map((r) => ({
    type: 'FRAUD_REVIEW', participantId: r.id, expected: Number(r.pending) * s.pointValuePaise,
    dedupe: `FRAUD:${r.id}:${r.last_flag}`, facts: { flags: r.flags, rules: r.rules, pendingPoints: Number(r.pending) },
  }));
}

// ── (g) A purchase scheme when dealers are slowing and none is running ───
async function schemeIdea(tenant, s, today, now) {
  if (ist(now).weekday !== 1) return []; // Mondays only
  const { rows: [live] } = await query(`
    SELECT 1 FROM schemes WHERE tenant_id=$1 AND type='PURCHASE_SLAB' AND status IN ('DRAFT','ACTIVE') AND ends_at > $2 LIMIT 1`, [tenant.id, now]);
  if (live) return [];
  const { rows } = await query(`
    SELECT i.participant_id, sum(i.total_paise)::bigint AS v FROM invoices i
     WHERE i.tenant_id=$1 AND i.status='PROCESSED' AND i.doc_type='INVOICE' AND i.invoice_date > $2::date - 90 GROUP BY 1`, [tenant.id, today]);
  const { rows: [risk] } = await query(`SELECT count(*)::int AS n FROM participants WHERE tenant_id=$1 AND status='ACTIVE' AND type = ANY($2::text[]) AND segment IN ('AT_RISK','DORMANT')`, [tenant.id, PURCHASE_TYPES]);
  if (rows.length < 5 || risk.n < 3) return [];
  const monthly = rows.map((r) => Number(r.v) / 3).sort((a, b) => a - b);
  const median = monthly.at(Math.floor(monthly.length / 2));
  const round = (paise) => Math.max(1000, Math.round(paise / 100 / 1000) * 1000); // rupees, to ₹1,000
  const silver = round(median * 1.2), gold = round(median * 1.6);
  const start = new Date(`${today}T00:00:00+05:30`); start.setUTCDate(start.getUTCDate() + 7);
  const end = new Date(start.getTime() + 30 * DAY);
  return [{
    type: 'SCHEME_IDEA', participantId: null, expected: Math.round(rows.length * median * 0.2),
    dedupe: `SCHEME:${isoWeek(now)}`,
    facts: {
      dealers: rows.length, atRisk: risk.n, medianMonthlyPaise: Math.round(median),
      draft: {
        name: `Dealer Booster · ${start.toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}`,
        description: `Buy ₹${silver.toLocaleString('en-IN')}+ in 30 days for a 1% bonus, ₹${gold.toLocaleString('en-IN')}+ for 2%.`,
        type: 'PURCHASE_SLAB', metric: 'AMOUNT', startsAt: start.toISOString(), endsAt: end.toISOString(), eligibleTypes: PURCHASE_TYPES,
        slabs: [{ min: silver, rewardType: 'PERCENT', value: 1, label: 'Silver' }, { min: gold, rewardType: 'PERCENT', value: 2, label: 'Gold' }],
      },
    },
  }];
}

// ── Words: what the owner reads, and what the dealer / mechanic gets ─────
async function compose(tenant, s, c, p) {
  const f = c.facts;
  const nm = p ? first(p) : '';
  switch (c.type) {
    case 'REORDER_NUDGE': {
      const items = f.basket.slice(0, 5).map((b) => `• ${b.name} × ${b.qty.toLocaleString('en-IN')}`).join('\n');
      const canReply = canOrder(tenant, p) && f.basket.some((b) => b.orderable);
      const msg = hi(p)
        ? `Namaste ${nm} ji 🙏 ${tenant.name} se.\nAapka pichla order ${shortDate(f.lastDate)} ko tha:\n${items}\n${canReply ? 'Wahi dobara mangwana hai? *REORDER* likho, cart ready ho jayega.' : 'Naya order chahiye toh yahan bata do.'}`
        : `Hello ${nm} 🙏 from ${tenant.name}.\nYour last order was on ${shortDate(f.lastDate)}:\n${items}\n${canReply ? 'Want the same again? Reply *REORDER* and your cart will be ready.' : 'Reply here if you need a new order.'}`;
      return {
        title: `Remind ${p.name || p.mobile} to reorder`,
        reason: `Orders about every ${f.gapDays} days; last order ${f.sinceDays} days ago (${f.orders} orders this year).`,
        payload: { message: msg, basket: f.basket, params: [nm, shortDate(f.lastDate), f.basket.slice(0, 4).map((b) => `${b.name} x${b.qty}`).join(', ')] },
      };
    }
    case 'WINBACK_CALL':
      return {
        title: `AI call to ${p.name || p.mobile}, quiet ${f.quietDays} days`,
        reason: `Bought ${rupee(f.bought180)} in the 6 months before going quiet ${f.quietDays} days ago.`,
        payload: { language: p.language === 'en' ? 'en' : 'hi', quietDays: f.quietDays },
      };
    case 'SLAB_PUSH': {
      const amt = f.metric === 'AMOUNT' ? `₹${Math.round(f.remaining).toLocaleString('en-IN')}` : `${Math.round(f.remaining)} ${f.metric === 'SCANS' ? 'scans' : 'units'}`;
      const msg = hi(p)
        ? `🎯 ${nm} ji, *${f.scheme}* mein aap agle slab ke bahut paas ho!\nSirf *${amt}* aur, aur milega *${f.reward}*.\nLast date: ${shortDate(f.endsAt)} (${f.daysLeft} din bache).`
        : `🎯 ${nm}, you're close to the next slab in *${f.scheme}*!\nJust *${amt}* more for *${f.reward}*.\nEnds ${shortDate(f.endsAt)} (${f.daysLeft} days left).`;
      return {
        title: `Push ${p.name || p.mobile} to the next slab in ${f.scheme}`,
        reason: `${amt} short of the next slab; scheme ends in ${f.daysLeft} days.`,
        payload: { message: msg, params: [nm, f.scheme, amt, f.reward, shortDate(f.endsAt)], schemeId: f.schemeId },
      };
    }
    case 'MECHANIC_NUDGE': {
      const w = await ledger.getWallet({ query }, p.id);
      const sch = (await progressFor({ tenant, participant: p })).find((x) => !x.upcoming);
      const schLine = sch ? (sch.type === 'SCAN_MULTIPLIER' ? `${sch.name}: ${sch.multiplier}x points` : sch.name) : '';
      const msg = hi(p)
        ? `Namaste ${nm} ji 🙏 ${f.quietDays} din se aapka koi scan nahi aaya.\nAapke paas *${w.balance.toLocaleString('en-IN')} points* hain (= ${rupee(w.balance * s.pointValuePaise)}).${schLine ? `\n🔥 ${schLine}` : ''}\nAgla genuine ${tenant.name} product scan karo aur points pao.`
        : `Hello ${nm} 🙏 we haven't seen a scan from you in ${f.quietDays} days.\nYou have *${w.balance.toLocaleString('en-IN')} points* (= ${rupee(w.balance * s.pointValuePaise)}).${schLine ? `\n🔥 ${schLine}` : ''}\nScan your next genuine ${tenant.name} product to earn more.`;
      return {
        title: `Bring back ${p.name || p.mobile} (${p.type.toLowerCase()})`,
        reason: `Used to earn ~${f.monthlyPoints} points a month; no scan for ${f.quietDays} days.`,
        payload: { message: msg, params: [nm, w.balance.toLocaleString('en-IN'), schLine || '-'] },
      };
    }
    case 'PAYMENT_REMINDER': {
      const msg = hi(p)
        ? `Namaste ${nm} ji 🙏 ${tenant.name} accounts se.\nAapke account mein *${rupee(f.overduePaise)}* ka payment due date se aage chal raha hai${f.oldestDue ? ` (sabse purana ${shortDate(f.oldestDue)} se)` : ''}.\nJab ho sake payment kar dijiye. Agar pehle hi kar diya hai toh ise ignore karein 🙏`
        : `Hello ${nm} 🙏 from ${tenant.name} accounts.\n*${rupee(f.overduePaise)}* on your account is past its due date${f.oldestDue ? ` (oldest from ${shortDate(f.oldestDue)})` : ''}.\nPlease clear it when you can. If you've already paid, please ignore this 🙏`;
      return {
        title: `Payment reminder to ${p.name || p.mobile}`,
        reason: `${rupee(f.overduePaise)} overdue, up to ${f.daysOverdue} days late.`,
        payload: { message: msg, overduePaise: f.overduePaise, params: [nm, rupee(f.overduePaise), f.oldestDue ? shortDate(f.oldestDue) : '-'] },
      };
    }
    case 'FRAUD_REVIEW':
      return {
        title: `Hold ${p.name || p.mobile}: ${f.flags} fraud flags, cash-out waiting`,
        reason: `${f.flags} fraud flags this week (${f.rules.join(', ').toLowerCase().replace(/_/g, ' ')}) and ${f.pendingPoints.toLocaleString('en-IN')} points waiting to be paid.`,
        payload: { pendingPoints: f.pendingPoints, rules: f.rules },
      };
    case 'SCHEME_IDEA':
      return {
        title: `New dealer scheme: ${f.draft.name}`,
        reason: `${f.atRisk} dealers are slowing down and no purchase scheme is running. ${f.draft.description}`,
        payload: { draft: f.draft, dealers: f.dealers },
      };
    default: return null;
  }
}

/** Plan one brand's day. Idempotent: the same action is never proposed twice. */
export async function planTenant(tenant, now = new Date()) {
  const s = aiSettings(tenant);
  const today = ist(now).date;
  const rates = await winRates(tenant.id);

  const all = [
    ...(await reorderCandidates(tenant, s, today)),
    ...(await winbackCandidates(tenant, s, today)),
    ...(await slabCandidates(tenant, s, today, now)),
    ...(await mechanicCandidates(tenant, s, today)),
    ...(await paymentCandidates(tenant, s, today)),
    ...(await fraudCandidates(tenant, s)),
    ...(await schemeIdea(tenant, s, today, now)),
  ].map((c) => ({ ...c, priority: (c.type === 'FRAUD_REVIEW' ? 3 : 1) * c.expected * rates[c.type] }))
    .sort((a, b) => b.priority - a.priority);

  // Guardrails, in one place.
  const { rows: [{ n: doneToday }] } = await query(`SELECT count(*)::int AS n FROM ai_actions WHERE tenant_id=$1 AND plan_date=$2 AND status NOT IN ('SKIPPED','EXPIRED')`, [tenant.id, today]);
  let room = s.aiDailyCap - doneToday;
  const seen = new Set();
  const planned = [];
  for (const c of all) {
    if (room <= 0) break;
    let p = null;
    if (c.participantId) {
      if (seen.has(c.participantId)) continue; // one action per person per plan
      ({ rows: [p] } = await query(`SELECT * FROM participants WHERE id=$1`, [c.participantId]));
      if (!p || p.status !== 'ACTIVE') continue;
      if (CHANNEL[c.type] === 'CALL' && p.dnd) continue;
      if (['REORDER_NUDGE', 'SLAB_PUSH', 'MECHANIC_NUDGE'].includes(c.type) && p.wa_opt_out) continue;
      const { rows: [open] } = await query(`SELECT 1 FROM ai_actions WHERE participant_id=$1 AND status IN ('PROPOSED','APPROVED','EXECUTING') LIMIT 1`, [p.id]);
      if (open) continue;
      if (CHANNEL[c.type] !== 'INTERNAL') {
        const { rows: [{ n }] } = await query(`
          SELECT ((SELECT count(*) FROM ai_actions WHERE participant_id=$1 AND status='DONE' AND executed_at > $2::timestamptz - interval '7 days')
                + (SELECT count(*) FROM wa_campaign_recipients r JOIN messages m ON m.id=r.message_id WHERE r.participant_id=$1 AND m.created_at > $2::timestamptz - interval '7 days')
                + (SELECT count(*) FROM calls WHERE participant_id=$1 AND status <> 'SKIPPED' AND created_at > $2::timestamptz - interval '7 days'))::int AS n`, [p.id, now]);
        if (n >= s.aiMaxTouchesPerWeek) continue;
      }
      seen.add(p.id);
    }
    const words = await compose(tenant, s, c, p);
    if (!words) continue;
    const autonomy = s.autonomy[c.type];
    const { rows: [a] } = await query(`
      INSERT INTO ai_actions (tenant_id, participant_id, type, status, autonomy, title, reason, payload, expected_paise, priority, plan_date, dedupe_key, decided_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (tenant_id, dedupe_key) DO NOTHING RETURNING *`,
    [tenant.id, c.participantId, c.type, autonomy === 'AUTO' ? 'APPROVED' : 'PROPOSED', autonomy, words.title, words.reason,
      JSON.stringify(words.payload), c.expected, c.priority, today, c.dedupe, autonomy === 'AUTO' ? 'auto' : null]);
    if (a) { planned.push(a); room--; }
  }
  await query(`INSERT INTO ai_state (tenant_id, last_plan_date) VALUES ($1,$2) ON CONFLICT (tenant_id) DO UPDATE SET last_plan_date=$2, updated_at=now()`, [tenant.id, today]);
  return planned;
}

export { ACTION_TYPES };
