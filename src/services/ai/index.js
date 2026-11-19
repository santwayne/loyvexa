import { query } from '../../db/pool.js';
import { planTenant } from './planner.js';
import { executeApproved } from './executor.js';
import { sendBrief, sendWeeklyReport } from './brief.js';
import { sweepOutcomes } from './attribution.js';
import { aiSettings, ist } from './settings.js';

/**
 * Worker tick for the AI Channel Manager (called from src/worker.js):
 *   - once a day at the brand's brief hour: plan, then text the owner the plan
 *   - Mondays: the weekly report
 *   - every tick: run approved actions (inside contact hours), score outcomes,
 *     expire plans nobody answered for 3 days
 */
export async function tickAi(now = new Date()) {
  const { rows: tenants } = await query(`SELECT t.*, st.last_plan_date FROM tenants t LEFT JOIN ai_state st ON st.tenant_id=t.id WHERE t.status='ACTIVE'`);
  const out = { planned: 0, briefs: 0, reports: 0 };
  const { date, hour, weekday } = ist(now);
  for (const t of tenants) {
    const s = aiSettings(t);
    if (!s.aiEnabled) continue;
    const last = t.last_plan_date ? new Date(t.last_plan_date).toISOString().slice(0, 10) : null;
    if (hour >= s.aiBriefHour && last !== date) {
      out.planned += (await planTenant(t, now)).length;
      out.briefs += (await sendBrief(t, now)).sent;
    }
    if (weekday === 1 && hour >= s.aiBriefHour) out.reports += (await sendWeeklyReport(t, now)).sent;
  }
  await query(`UPDATE ai_actions SET status='EXPIRED', updated_at=now() WHERE status='PROPOSED' AND plan_date < ($1::date - 3)`, [date]);
  out.executed = await executeApproved({ now });
  out.outcomes = await sweepOutcomes(now);
  return out;
}

export { planTenant } from './planner.js';
export { decide, executeAction } from './executor.js';
export { composeBrief, sendBrief, handleOwnerMessage, weeklyReportText } from './brief.js';
export { sweepOutcomes, stats } from './attribution.js';
