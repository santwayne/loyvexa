import { settingsOf } from '../tenants.js';
import { normalizeMobile } from '../../lib/codes.js';
import { hasWayneRing } from '../bundle.js';

/**
 * AI Channel Manager — shared definitions.
 *
 * Every morning it looks at orders (Korvo / Tally invoices), scans, schemes,
 * outstanding payments and fraud flags, and proposes the actions most likely
 * to bring in sales. The brand's owner or sales head approves them on
 * WhatsApp ("1 3", "ALL") or in the console. Then it carries them out and
 * checks, two weeks later, whether each one worked.
 */
export const ACTION_TYPES = ['REORDER_NUDGE', 'SLAB_PUSH', 'WINBACK_CALL', 'MECHANIC_NUDGE', 'PAYMENT_REMINDER', 'FRAUD_REVIEW', 'SCHEME_IDEA'];

/**
 * Bundle rule (Nov 2026): the AI Manager keeps only loyalty work.
 *   Stay:  scheme slab push, mechanic nudge, fraud hold, scheme idea,
 *          win-back AI call (only with WayneRing in the package).
 *   Moved: reorder nudge → Regulars (with Korvo data); payment reminder →
 *          Korvo decides, Regulars sends. Old rows of these types stay for history.
 */
export const MOVED_OUT = { REORDER_NUDGE: 'Reorder reminders are sent by Regulars now', PAYMENT_REMINDER: 'Payment reminders are decided by Korvo and sent by Regulars now' };
export const LOYALTY_ACTIONS = ['SLAB_PUSH', 'MECHANIC_NUDGE', 'FRAUD_REVIEW', 'SCHEME_IDEA', 'WINBACK_CALL'];
/** The action types this brand's AI Manager may plan. */
export const actionTypesFor = (tenant) => LOYALTY_ACTIONS.filter((t) => t !== 'WINBACK_CALL' || hasWayneRing(tenant));

export const LABEL = {
  REORDER_NUDGE: { one: 'Reorder reminder', many: 'reorder reminders', hi: 'reorder yaad dilana' },
  SLAB_PUSH: { one: 'Scheme slab push', many: 'scheme slab pushes', hi: 'agla slab dilana' },
  WINBACK_CALL: { one: 'Win-back AI call', many: 'win-back calls', hi: 'chup dealer ko AI call' },
  MECHANIC_NUDGE: { one: 'Mechanic nudge', many: 'mechanic nudges', hi: 'mechanic ko yaad dilana' },
  PAYMENT_REMINDER: { one: 'Payment reminder', many: 'payment reminders', hi: 'payment reminder' },
  FRAUD_REVIEW: { one: 'Fraud hold', many: 'fraud holds', hi: 'fraud rokna' },
  SCHEME_IDEA: { one: 'Scheme idea', many: 'scheme ideas', hi: 'nayi scheme ka idea' },
};

/** Who gets contacted, and how. */
export const CHANNEL = {
  REORDER_NUDGE: 'WHATSAPP', SLAB_PUSH: 'WHATSAPP', MECHANIC_NUDGE: 'WHATSAPP', PAYMENT_REMINDER: 'WHATSAPP',
  WINBACK_CALL: 'CALL', FRAUD_REVIEW: 'INTERNAL', SCHEME_IDEA: 'INTERNAL',
};

/** Ask first, except where a mistake is cheap. Fraud holds can never run on their own. */
export const DEFAULT_AUTONOMY = {
  REORDER_NUDGE: 'APPROVE', SLAB_PUSH: 'APPROVE', WINBACK_CALL: 'APPROVE', MECHANIC_NUDGE: 'AUTO',
  PAYMENT_REMINDER: 'APPROVE', FRAUD_REVIEW: 'APPROVE', SCHEME_IDEA: 'SUGGEST',
};
export const NEVER_AUTO = ['FRAUD_REVIEW', 'SCHEME_IDEA'];

/** Starting guesses for "how often does this work", until the brand has its own history. */
export const BASE_WIN_RATE = {
  REORDER_NUDGE: 0.35, SLAB_PUSH: 0.3, WINBACK_CALL: 0.15, MECHANIC_NUDGE: 0.2, PAYMENT_REMINDER: 0.4, FRAUD_REVIEW: 0.6, SCHEME_IDEA: 0.25,
};

export const ATTRIBUTION_DAYS = 14;
export const DAY = 86400000;

export function aiSettings(tenant) {
  const s = settingsOf(tenant);
  const autonomy = { ...DEFAULT_AUTONOMY, ...(s.aiAutonomy || {}) };
  for (const t of NEVER_AUTO) if (autonomy[t] === 'AUTO') autonomy[t] = 'APPROVE';
  return { ...s, autonomy, aiBriefNumbers: (s.aiBriefNumbers || []).map((m) => normalizeMobile(m)).filter(Boolean) };
}

/** IST calendar parts. */
export function ist(d = new Date()) {
  const t = new Date(d.getTime() + 5.5 * 3600e3);
  return { date: t.toISOString().slice(0, 10), hour: t.getUTCHours(), weekday: t.getUTCDay() };
}
export const isoWeek = (d = new Date()) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y) / DAY + 1) / 7)).padStart(2, '0')}`;
};
export const withinContactHours = (s, d = new Date()) => { const h = ist(d).hour; return h >= s.aiContactFromHour && h < s.aiContactToHour; };
export const rupee = (paise) => `₹${Math.round(Number(paise) / 100).toLocaleString('en-IN')}`;
export const shortDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
