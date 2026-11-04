import { query } from '../db/pool.js';
import { config } from '../config.js';
import { normalizeMobile, extractCode } from '../lib/codes.js';
import { settingsOf } from './tenants.js';
import { sendText } from './whatsapp.js';
import { scan } from './scan.js';
import { progressFor } from './schemes.js';
import * as ledger from './ledger.js';

/**
 * WhatsApp bot for dealers + mechanics. Works in Roman Hinglish (default) or English.
 *   1 / points / balance      -> balance
 *   2 / scheme / offer        -> live scheme progress
 *   3 / history               -> last 5 transactions
 *   <product code>            -> scan-to-earn straight from WhatsApp
 *   english / hindi           -> switch language
 *   anything else             -> menu
 */
const rupee = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

const L = {
  hi: {
    menu: (n, b, link) => `Namaste${n ? ` ${n}` : ''} 🙏\n*${b} Rewards*\n\n1️⃣ Mere points\n2️⃣ Schemes / offers\n3️⃣ Last 5 transactions\n\n📷 Product ka code type karke bhejo (jaise ABCD-EFGH-JKMN), points turant milenge.\n\n📱 App: ${link}`,
    notRegistered: (b, link) => `Namaste 🙏 Ye *${b} Rewards* ka number hai.\nAap abhi registered nahi ho. Is link se 1 minute mein join karo:\n${link}`,
    blocked: 'Aapka account abhi band hai. Brand se sampark karo.',
    balance: (w, rupees, link) => `💰 *${w.balance.toLocaleString('en-IN')} points* (= ${rupees})${w.held ? `\n⏳ ${w.held} points payment mein` : ''}\n\nUPI mein paise nikalne ke liye app kholo:\n${link}`,
    noSchemes: 'Abhi koi scheme live nahi hai. Nayi scheme aate hi yahan bataenge 👍',
    schemesHead: '🎯 *Aapki schemes*',
    ends: (d) => `Last date: ${d}`,
    starts: (d) => `Shuru: ${d}`,
    multiplier: (m) => `Har scan pe *${m}x points*`,
    progressAmt: (v) => `Kharida: *${rupee(v)}*`,
    progressQty: (v) => `Quantity: *${v.toLocaleString('en-IN')}*`,
    progressScans: (v) => `Scans: *${v}*`,
    current: (label, pts) => `✅ Slab: ${label} → ${pts.toLocaleString('en-IN')} points`,
    none: 'Abhi koi slab nahi bana',
    nextAmt: (min, rem, reward) => `➡️ Agla slab ${rupee(min)} pe (${reward}) — sirf *${rupee(rem)}* aur`,
    nextUnits: (min, rem, unit, reward) => `➡️ Agla slab ${min} ${unit} pe (${reward}) — sirf *${rem}* aur`,
    top: '🏆 Sabse upar wala slab mil gaya!',
    reward: (s) => (s.rewardType === 'PERCENT' ? `${s.value}% bonus` : s.rewardType === 'PER_UNIT' ? `${s.value} pts/unit` : `${s.value} points`),
    historyHead: '🧾 *Last 5 transactions*', historyEmpty: 'Abhi tak koi transaction nahi.',
    lt: { EARN_SCAN: 'Scan', REDEEM_HOLD: 'Cash out', REDEEM_RELEASE: 'Wapas', ADJUST_CREDIT: 'Bonus', ADJUST_DEBIT: 'Katauti', BONUS: 'Bonus', PURCHASE_EARN: 'Purchase', PURCHASE_REVERSAL: 'Return', SCHEME_BONUS: 'Scheme bonus', EXPIRE: 'Expire' },
    scanOk: (pts, prod, bal, bonus) => `🎉 *+${pts} points* — ${prod}${bonus ? `\n🔥 ${bonus}` : ''}\nBalance: ${bal.toLocaleString('en-IN')} points`,
    scanFail: (m) => `⚠️ ${m}`,
    lang: 'Theek hai, ab Hinglish mein baat karenge 👍',
    scanErr: { INVALID: 'Ye code sahi nahi hai. Product nakli ho sakta hai.', WRONG_BRAND: 'Ye code kisi aur brand ka hai.', ALREADY_SCANNED: 'Ye code pehle hi use ho chuka hai.', VOID: 'Ye code brand ne radd kar diya hai.', INACTIVE_PRODUCT: 'Ye product abhi reward mein nahi hai.', LIMIT: 'Scan limit poori ho gayi, thodi der baad try karo.', BLOCKED: 'Scanning abhi band hai. Brand se baat karo.' },
  },
  en: {
    menu: (n, b, link) => `Hello${n ? ` ${n}` : ''} 🙏\n*${b} Rewards*\n\n1️⃣ My points\n2️⃣ Schemes / offers\n3️⃣ Last 5 transactions\n\n📷 Type and send a product code (like ABCD-EFGH-JKMN) to earn points instantly.\n\n📱 App: ${link}`,
    notRegistered: (b, link) => `Hello 🙏 This is *${b} Rewards*.\nYou're not registered yet. Join in 1 minute:\n${link}`,
    blocked: 'Your account is blocked. Please contact the brand.',
    balance: (w, rupees, link) => `💰 *${w.balance.toLocaleString('en-IN')} points* (= ${rupees})${w.held ? `\n⏳ ${w.held} points in payout` : ''}\n\nTo cash out to UPI, open the app:\n${link}`,
    noSchemes: 'No live schemes right now. We will message you when one starts 👍',
    schemesHead: '🎯 *Your schemes*',
    ends: (d) => `Ends: ${d}`, starts: (d) => `Starts: ${d}`,
    multiplier: (m) => `*${m}x points* on every scan`,
    progressAmt: (v) => `Purchased: *${rupee(v)}*`, progressQty: (v) => `Quantity: *${v.toLocaleString('en-IN')}*`, progressScans: (v) => `Scans: *${v}*`,
    current: (label, pts) => `✅ Slab: ${label} → ${pts.toLocaleString('en-IN')} points`, none: 'No slab reached yet',
    nextAmt: (min, rem, reward) => `➡️ Next slab at ${rupee(min)} (${reward}) — only *${rupee(rem)}* more`,
    nextUnits: (min, rem, unit, reward) => `➡️ Next slab at ${min} ${unit} (${reward}) — only *${rem}* more`,
    top: '🏆 Top slab reached!',
    reward: (s) => (s.rewardType === 'PERCENT' ? `${s.value}% bonus` : s.rewardType === 'PER_UNIT' ? `${s.value} pts/unit` : `${s.value} points`),
    historyHead: '🧾 *Last 5 transactions*', historyEmpty: 'No transactions yet.',
    lt: { EARN_SCAN: 'Scan', REDEEM_HOLD: 'Cash out', REDEEM_RELEASE: 'Returned', ADJUST_CREDIT: 'Bonus', ADJUST_DEBIT: 'Deduction', BONUS: 'Bonus', PURCHASE_EARN: 'Purchase', PURCHASE_REVERSAL: 'Return', SCHEME_BONUS: 'Scheme bonus', EXPIRE: 'Expired' },
    scanOk: (pts, prod, bal, bonus) => `🎉 *+${pts} points* — ${prod}${bonus ? `\n🔥 ${bonus}` : ''}\nBalance: ${bal.toLocaleString('en-IN')} points`,
    scanFail: (m) => `⚠️ ${m}`,
    lang: 'Done — I will reply in English now 👍',
    scanErr: {},
  },
};

export const appLink = (tenant) => `${config.publicBaseUrl}/app/?brand=${tenant.slug}`;

function intent(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/^(english|eng)$/.test(t)) return 'LANG_EN';
  if (/^(hindi|hinglish|हिंदी)$/.test(t)) return 'LANG_HI';
  if (/^(1|points?|balance|bal|pts|पॉइंट|पॉइंट्स|बैलेंस|wallet)\b/.test(t)) return 'BALANCE';
  if (/^(2|schemes?|offers?|skeem|scheem|स्कीम|ऑफर|target)\b/.test(t)) return 'SCHEMES';
  if (/^(3|history|statement|hisab|हिस्ट्री)\b/.test(t)) return 'HISTORY';
  if (looksLikeCode(text)) return 'CODE';
  return 'MENU';
}

// Only treat a message as a product code if it clearly is one, so chatty messages
// ("namaskarji") never count as invalid scans and lock a mechanic out.
export function looksLikeCode(text) {
  const raw = String(text || '').trim();
  if (/\/q\/[0-9A-Za-z]{8,16}/.test(raw)) return true;
  const s = raw.replace(/\s+/g, '');
  if (/^[0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}$/.test(s)) return !!extractCode(s);
  return /^[0-9A-Za-z]{12}$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s) && !!extractCode(s);
}

export function schemesText(lang, schemes) {
  const l = L[lang];
  if (!schemes.length) return l.noSchemes;
  const parts = [l.schemesHead];
  for (const s of schemes) {
    const lines = [`\n*${s.name}*`];
    if (s.description) lines.push(s.description);
    lines.push(s.upcoming ? l.starts(fmtDate(s.startsAt)) : l.ends(fmtDate(new Date(new Date(s.endsAt).getTime() - 1000))));
    if (s.type === 'SCAN_MULTIPLIER') { lines.push(l.multiplier(s.multiplier)); parts.push(lines.join('\n')); continue; }
    const p = s.progress;
    lines.push(s.metric === 'AMOUNT' ? l.progressAmt(p.value) : s.metric === 'QUANTITY' ? l.progressQty(p.value) : l.progressScans(p.value));
    lines.push(p.slab ? l.current(p.slab.label || l.reward(p.slab), p.points) : l.none);
    if (p.nextSlab) {
      lines.push(s.metric === 'AMOUNT' ? l.nextAmt(p.nextSlab.min, p.remainingToNext, l.reward(p.nextSlab))
        : l.nextUnits(p.nextSlab.min, p.remainingToNext, s.metric === 'SCANS' ? 'scans' : 'units', l.reward(p.nextSlab)));
    } else if (p.slab) lines.push(l.top);
    parts.push(lines.join('\n'));
  }
  return parts.join('\n');
}

/** Handle one inbound WhatsApp text. Returns the reply text (also sent). */
export async function handleInbound({ channel, from, text, providerMsgId }) {
  const tenant = channel.tenant;
  const mobile = normalizeMobile(from);
  const ins = await query(
    `INSERT INTO messages (tenant_id, direction, peer, body, provider_msg_id, status) VALUES ($1,'IN',$2,$3,$4,'RECEIVED')
     ON CONFLICT DO NOTHING RETURNING id`, [tenant.id, mobile || from, text, providerMsgId || null]);
  if (providerMsgId && !ins.rowCount) return null; // Meta retried a message we already handled

  const { rows: [p] } = await query(`SELECT * FROM participants WHERE tenant_id=$1 AND mobile=$2`, [tenant.id, mobile]);
  if (p) await query(`UPDATE messages SET participant_id=$1 WHERE id=$2`, [p.id, ins.rows[0]?.id]);
  const reply = (t) => sendText({ tenantId: tenant.id, participantId: p?.id, to: from, text: t }).then(() => t);

  if (!p) return reply(L.hi.notRegistered(tenant.name, appLink(tenant)));
  let lang = p.language === 'en' ? 'en' : 'hi';
  const l = () => L[lang];
  if (p.status !== 'ACTIVE') return reply(l().blocked);

  const it = intent(text);
  if (it === 'LANG_EN' || it === 'LANG_HI') {
    lang = it === 'LANG_EN' ? 'en' : 'hi';
    await query(`UPDATE participants SET language=$2 WHERE id=$1`, [p.id, lang]);
    return reply(`${l().lang}\n\n${l().menu(p.name, tenant.name, appLink(tenant))}`);
  }
  if (it === 'BALANCE') {
    const w = await ledger.getWallet({ query }, p.id);
    const s = settingsOf(tenant);
    return reply(l().balance(w, rupee((w.balance * s.pointValuePaise) / 100), appLink(tenant)));
  }
  if (it === 'SCHEMES') return reply(schemesText(lang, await progressFor({ tenant, participant: p })));
  if (it === 'HISTORY') {
    const { rows } = await query(`SELECT type, points, note, created_at FROM ledger_entries WHERE participant_id=$1 ORDER BY id DESC LIMIT 5`, [p.id]);
    if (!rows.length) return reply(l().historyEmpty);
    return reply([l().historyHead, ...rows.map((r) => `${r.points > 0 ? '➕' : '➖'} ${Math.abs(r.points)} · ${l().lt[r.type] || r.type}${r.note ? ` · ${r.note}` : ''} · ${fmtDate(r.created_at)}`)].join('\n'));
  }
  if (it === 'CODE') {
    const r = await scan({ tenant, participantId: p.id, input: String(text).replace(/\s+/g, ''), deviceId: `wa:${mobile}` });
    if (r.ok) return reply(l().scanOk(r.points + (r.bonus?.points || 0), r.product.name, r.wallet.balance, r.bonus ? `${r.bonus.scheme}: +${r.bonus.points}` : null));
    return reply(l().scanFail(l().scanErr[r.result] || r.message));
  }
  return reply(l().menu(p.name, tenant.name, appLink(tenant)));
}

export { L as BOT_TEXT };
