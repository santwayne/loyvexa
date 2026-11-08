import { query } from '../../db/pool.js';
import { config } from '../../config.js';
import { sendBusiness } from './messaging.js';
import { decide } from './executor.js';
import { stats } from './attribution.js';
import { CHANNEL, LABEL, aiSettings, ist, isoWeek, rupee } from './settings.js';

/**
 * The owner's side: a numbered morning plan on WhatsApp, approvals by reply
 * ("1 3", "ALL", "SKIP"), and a Monday report. In Hinglish by default —
 * the way most brand owners and sales heads text.
 */
const MAX_ITEMS = 9;
const CH = { WHATSAPP: 'WhatsApp', CALL: 'AI call', INTERNAL: 'console' };

/** Number today's waiting actions 1…9 and write the text. */
export async function composeBrief(tenant, now = new Date()) {
  const today = ist(now).date;
  const { rows } = await query(`
    SELECT * FROM ai_actions WHERE tenant_id=$1 AND status='PROPOSED' AND plan_date >= $2::date - 2
     ORDER BY (autonomy='SUGGEST'), priority DESC LIMIT $3`, [tenant.id, today, MAX_ITEMS]);
  let i = 0;
  for (const a of rows) {
    i++;
    await query(`UPDATE ai_actions SET brief_date=$2, brief_item=$3 WHERE id=$1`, [a.id, today, i]);
    a.brief_item = i;
  }
  const st = await stats(tenant.id, 7);
  const lines = rows.map((a) => `${a.brief_item}. ${a.title} — ${a.reason}${a.expected_paise > 0 ? ` (~${rupee(a.expected_paise)})` : ''} [${CH[CHANNEL[a.type]]}]`);
  const total = rows.reduce((t, a) => t + Number(a.expected_paise), 0);
  const text = rows.length
    ? [`🌅 *${tenant.name} · AI Channel Manager*`, `Aaj ke ${rows.length} kaam (~${rupee(total)} ka business):`, '', ...lines, '',
      st.done ? `Pichle 7 din: ${st.done} kaam kiye, ${st.won} se ${rupee(st.wonPaise)} ka business aaya.` : null,
      'Reply: *1 3* (sirf ye) · *ALL* (sab) · *SKIP* (aaj kuch nahi)'].filter((x) => x !== null).join('\n')
    : `🌅 *${tenant.name} · AI Channel Manager*\nAaj koi naya kaam nahi. Sab dealers time pe hain 👍`;
  return { text, items: rows, total };
}

export async function sendBrief(tenant, now = new Date()) {
  const s = aiSettings(tenant);
  const brief = await composeBrief(tenant, now);
  if (!brief.items.length) return { sent: 0, items: 0 };
  let sent = 0;
  for (const to of s.aiBriefNumbers) {
    const r = await sendBusiness({ tenantId: tenant.id, to, eventType: 'ai.brief', text: brief.text, params: [tenant.name, String(brief.items.length), rupee(brief.total)] });
    if (r.status.startsWith('sent')) sent++;
  }
  return { sent, items: brief.items.length };
}

/** Parse the owner's reply. Returns null for messages that aren't AI commands. */
export function parseOwnerReply(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/^(all|sab|sabhi|haan sab|yes all|ok all)$/.test(t)) return { kind: 'ALL' };
  if (/^(skip|nahi|none|no|aaj nahi)$/.test(t)) return { kind: 'SKIP' };
  if (/^(plan|ai|aaj|today|brief)$/.test(t)) return { kind: 'PLAN' };
  if (/^(report|hisab|result|results)$/.test(t)) return { kind: 'REPORT' };
  if (/^\d{1,2}([\s,]+\d{1,2})*$/.test(t)) {
    const items = [...new Set(t.split(/[\s,]+/).map(Number))].filter((n) => n >= 1 && n <= MAX_ITEMS);
    return items.length ? { kind: 'ITEMS', items } : null;
  }
  return null;
}

/** Owner texted the brand's WhatsApp number. Returns the reply text, or null to let the normal bot handle it. */
export async function handleOwnerMessage({ tenant, mobile, text, now = new Date() }) {
  const s = aiSettings(tenant);
  if (!s.aiEnabled || !s.aiBriefNumbers.includes(mobile)) return null;
  const cmd = parseOwnerReply(text);
  if (!cmd) return null;
  if (cmd.kind === 'PLAN') return (await composeBrief(tenant, now)).text;
  if (cmd.kind === 'REPORT') return (await weeklyReportText(tenant)).text;

  const today = ist(now).date;
  const { rows: items } = await query(`SELECT * FROM ai_actions WHERE tenant_id=$1 AND brief_date=$2 AND status='PROPOSED' ORDER BY brief_item`, [tenant.id, today]);
  if (!items.length) return 'Aaj ke saare kaam ho chuke hain ya pehle hi decide ho gaye. *PLAN* bhejo naya list dekhne ke liye.';
  const by = `whatsapp:${mobile}`;
  if (cmd.kind === 'SKIP') {
    for (const a of items) await decide({ tenantId: tenant.id, actionId: a.id, decision: 'skip', by, now });
    return `Theek hai, aaj ke ${items.length} kaam skip kar diye 👍`;
  }
  const chosen = cmd.kind === 'ALL' ? items : items.filter((a) => cmd.items.includes(a.brief_item));
  if (!chosen.length) return `Ye number list mein nahi hain. *PLAN* bhejo list dekhne ke liye.`;
  const out = [];
  for (const a of chosen) {
    const r = await decide({ tenantId: tenant.id, actionId: a.id, decision: 'approve', by, now });
    const word = r.status === 'DONE' ? '✅ ho gaya' : r.status === 'DEFERRED' ? '⏰ business hours mein jayega' : r.status === 'FAILED' ? `⚠️ nahi hua (${r.error})` : `• ${String(r.status).toLowerCase()}`;
    out.push(`${a.brief_item}. ${a.title} — ${word}`);
  }
  return out.join('\n');
}

const insightCache = new Map();

/** One or two sentences on what stood out — Claude if a key is set, plain otherwise. */
export async function insightFor(tenant, st, fetchImpl = fetch) {
  const best = st.byType.find((t) => t.won > 0);
  const plain = best
    ? `${LABEL[best.type].many[0].toUpperCase()}${LABEL[best.type].many.slice(1)} worked best this week (${best.won} of ${best.done}, ${rupee(best.won_paise)}).`
    : 'No clear winner yet — results firm up after two to three weeks.';
  if (!config.anthropicApiKey || !st.byType.length) return plain;
  const key = `${tenant.id}:${isoWeek()}`;
  if (insightCache.has(key)) return insightCache.get(key);
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': config.anthropicApiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: config.aiModel, max_tokens: 200,
        system: 'You write one or two short sentences in simple Hinglish (Roman script) for an Indian manufacturer\'s sales head, summarising which follow-up actions brought in business this week and what to do next. Use only the numbers given. No greetings, no emojis, no markdown.',
        messages: [{ role: 'user', content: JSON.stringify({ brand: tenant.name, last7Days: { done: st.done, won: st.won, rupeesInfluenced: Math.round(st.wonPaise / 100), rupeesCollected: Math.round(st.collectedPaise / 100) }, byType: st.byType.map((t) => ({ type: LABEL[t.type]?.one, done: t.done, won: t.won, rupees: Math.round(t.won_paise / 100) })) }) }],
      }),
    });
    const j = await res.json();
    const text = j?.content?.[0]?.text?.trim();
    const out = text && text.length < 400 ? text : plain;
    insightCache.set(key, out);
    return out;
  } catch {
    return plain;
  }
}

export async function weeklyReportText(tenant) {
  const st = await stats(tenant.id, 7);
  const lines = st.byType.filter((t) => t.done || t.won).map((t) => `• ${LABEL[t.type].one}: ${t.done} kiye, ${t.won} kaam aaye${t.won_paise ? `, ${rupee(t.won_paise)}` : ''}`);
  const text = [`📊 *${tenant.name} · AI ki hafte ki report*`,
    `${st.done} kaam kiye · ${st.won} se business aaya · *${rupee(st.wonPaise)}*${st.collectedPaise ? ` (isme ${rupee(st.collectedPaise)} payment recovery)` : ''}`,
    st.heldPoints ? `🛡️ ${st.heldPoints.toLocaleString('en-IN')} points ke shaky payouts roke gaye` : null,
    ...lines, '', await insightFor(tenant, st),
    '_Business jo kaam ke 14 din ke andar aaya, use count kiya hai._'].filter((x) => x !== null).join('\n');
  return { text, stats: st };
}

export async function sendWeeklyReport(tenant, now = new Date()) {
  const s = aiSettings(tenant);
  const week = isoWeek(now);
  const { rows: [st] } = await query(`SELECT last_report_week FROM ai_state WHERE tenant_id=$1`, [tenant.id]);
  if (st?.last_report_week === week) return { sent: 0 };
  const r = await weeklyReportText(tenant);
  let sent = 0;
  for (const to of s.aiBriefNumbers) {
    const x = await sendBusiness({ tenantId: tenant.id, to, eventType: 'ai.report', text: r.text, params: [tenant.name, String(r.stats.done), rupee(r.stats.wonPaise)] });
    if (x.status.startsWith('sent')) sent++;
  }
  await query(`INSERT INTO ai_state (tenant_id, last_report_week) VALUES ($1,$2) ON CONFLICT (tenant_id) DO UPDATE SET last_report_week=$2, updated_at=now()`, [tenant.id, week]);
  return { sent };
}
