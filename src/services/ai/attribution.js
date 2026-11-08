import { query } from '../../db/pool.js';
import { settingsOf } from '../tenants.js';
import { ATTRIBUTION_DAYS, DAY } from './settings.js';

/**
 * Did it work? For each action done in the last 14 days, look for what
 * happened next with that person:
 *   reorder / slab push / win-back call → a purchase invoice or a WhatsApp order
 *   mechanic nudge                      → scans (valued at points × point value)
 *   payment reminder                    → overdue amount went down in the next Korvo snapshot
 *   scheme idea                         → the draft was activated (no ₹ claimed)
 * First result wins; after 14 days with nothing, the outcome is NONE.
 * This is "revenue influenced", not proof the AI caused it.
 */
export async function sweepOutcomes(now = new Date()) {
  const { rows } = await query(`
    SELECT a.*, row_to_json(t.*) AS tenant FROM ai_actions a JOIN tenants t ON t.id=a.tenant_id
     WHERE a.status='DONE' AND a.outcome IS NULL AND a.executed_at IS NOT NULL`);
  let won = 0, none = 0;
  for (const a of rows) {
    const s = settingsOf(a.tenant);
    const since = a.executed_at;
    let value = null;
    if (['REORDER_NUDGE', 'SLAB_PUSH', 'WINBACK_CALL'].includes(a.type)) {
      const { rows: [inv] } = await query(`
        SELECT coalesce(sum(total_paise),0)::bigint AS v, count(*)::int AS n FROM invoices
         WHERE participant_id=$1 AND status='PROCESSED' AND doc_type='INVOICE' AND created_at > $2 AND invoice_date >= ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date`, [a.participant_id, since]);
      if (inv.n) value = Number(inv.v);
      else {
        const { rows: [o] } = await query(`SELECT coalesce(sum(total_paise),0)::bigint AS v, count(*)::int AS n FROM orders WHERE participant_id=$1 AND status IN ('PLACED','SENT_TO_DMS') AND placed_at > $2`, [a.participant_id, since]);
        if (o.n) value = Number(o.v);
      }
    } else if (a.type === 'MECHANIC_NUDGE') {
      const { rows: [sc] } = await query(`SELECT coalesce(sum(points),0)::bigint AS pts, count(*)::int AS n FROM ledger_entries WHERE participant_id=$1 AND type='EARN_SCAN' AND created_at > $2`, [a.participant_id, since]);
      if (sc.n) value = Number(sc.pts) * s.pointValuePaise;
    } else if (a.type === 'PAYMENT_REMINDER') {
      const { rows: [h] } = await query(`SELECT min(overdue_paise)::bigint AS low FROM dealer_outstanding_history WHERE participant_id=$1 AND as_of > $2`, [a.participant_id, since]);
      const before = Number(a.payload?.overduePaise || 0);
      if (h.low != null && Number(h.low) < before) value = before - Number(h.low);
    } else if (a.type === 'SCHEME_IDEA') {
      const { rows: [sc] } = a.result?.schemeId ? await query(`SELECT status FROM schemes WHERE id=$1`, [a.result.schemeId]) : { rows: [] };
      if (sc && ['ACTIVE', 'SETTLED'].includes(sc.status)) value = 0;
    } else if (a.type === 'FRAUD_REVIEW') {
      // Not revenue. Recorded as NONE; the console shows payouts held separately.
      await query(`UPDATE ai_actions SET outcome='NONE', outcome_at=now() WHERE id=$1`, [a.id]); none++; continue;
    }
    if (value != null) {
      await query(`UPDATE ai_actions SET outcome='WON', outcome_paise=$2, outcome_at=now(), updated_at=now() WHERE id=$1`, [a.id, value]);
      won++;
    } else if (now.getTime() - new Date(since).getTime() > ATTRIBUTION_DAYS * DAY) {
      await query(`UPDATE ai_actions SET outcome='NONE', outcome_at=now(), updated_at=now() WHERE id=$1`, [a.id]);
      none++;
    }
  }
  return { won, none };
}

/** Totals for the console and the weekly text. */
export async function stats(tenantId, days = 7) {
  const { rows: [t] } = await query(`
    SELECT count(*) FILTER (WHERE status='DONE' AND executed_at > now() - make_interval(days => $2))::int AS done,
           count(*) FILTER (WHERE outcome='WON' AND outcome_at > now() - make_interval(days => $2))::int AS won,
           coalesce(sum(outcome_paise) FILTER (WHERE outcome='WON' AND outcome_at > now() - make_interval(days => $2)),0)::bigint AS won_paise,
           coalesce(sum(outcome_paise) FILTER (WHERE outcome='WON' AND type='PAYMENT_REMINDER' AND outcome_at > now() - make_interval(days => $2)),0)::bigint AS collected_paise,
           coalesce(sum((payload->>'pendingPoints')::bigint) FILTER (WHERE type='FRAUD_REVIEW' AND status='DONE' AND executed_at > now() - make_interval(days => $2)),0)::bigint AS held_points,
           count(*) FILTER (WHERE status='PROPOSED')::int AS waiting
      FROM ai_actions WHERE tenant_id=$1`, [tenantId, days]);
  const { rows: byType } = await query(`
    SELECT type, count(*) FILTER (WHERE status='DONE')::int AS done, count(*) FILTER (WHERE outcome='WON')::int AS won,
           coalesce(sum(outcome_paise) FILTER (WHERE outcome='WON'),0)::bigint AS won_paise
      FROM ai_actions WHERE tenant_id=$1 AND (executed_at > now() - make_interval(days => $2) OR outcome_at > now() - make_interval(days => $2)) GROUP BY 1 ORDER BY 4 DESC`, [tenantId, days]);
  return { ...t, done: t.done, won: t.won, wonPaise: Number(t.won_paise), collectedPaise: Number(t.collected_paise), heldPoints: Number(t.held_points), waiting: t.waiting, byType: byType.map((r) => ({ ...r, won_paise: Number(r.won_paise) })) };
}
