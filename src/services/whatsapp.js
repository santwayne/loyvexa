import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { decrypt, safeEqual } from '../lib/crypto.js';
import { waViaRegulars } from './bundle.js';
import { badRequest } from '../lib/errors.js';
import { normalizeMobile } from '../lib/codes.js';

/**
 * WhatsApp Cloud API sender. One number per brand (tenant_channels).
 * WHATSAPP_SEND_MODE=mock stores outgoing messages in `messages` without calling Meta,
 * so the whole bot can be tested before a number is approved.
 *
 * Meta rule: free-form text only within 24h of the user's last message.
 * Anything business-initiated (payout done, scheme bonus, OTP) must use an approved template.
 *
 * Bundle rule 4: a brand made by the Regulars hub sends through Regulars (the
 * client's one WhatsApp number, set up in Regulars Settings) — see regularsSend.
 */
export async function channelForTenant(tenantId) {
  const { rows: [c] } = await query(`SELECT * FROM tenant_channels WHERE tenant_id=$1 AND channel='WHATSAPP' AND status='ACTIVE'`, [tenantId]);
  return c || null;
}
/** Regulars owns the templates for hub brands: Loyvexa asks for them by a fixed name per event. */
export const regularsTemplateName = (key) => `loyvexa_${String(key).toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;

/**
 * Who sends this brand's WhatsApp, and which approved template to use for an
 * event ('otp', 'ai.slab', 'redemption.paid'…). Bundle brands: Regulars, with
 * its templates (name = regularsTemplateName(key), language hi unless the
 * brand's own channel config says otherwise). Others: the brand's own number.
 */
export async function senderFor(tenantId) {
  const { rows: [tenant] } = await query(`SELECT id, hub_business_id FROM tenants WHERE id=$1`, [tenantId]);
  const channel = await channelForTenant(tenantId);
  const viaRegulars = waViaRegulars(tenant);
  const template = (key) => {
    const own = key === 'otp' ? channel?.config?.otpTemplate : channel?.config?.templates?.[key];
    if (own) return typeof own === 'string' ? { name: own } : own;
    return viaRegulars ? { name: regularsTemplateName(key), language: config.whatsapp.templateLanguage || 'en', guessed: true } : null;
  };
  return { viaRegulars, ready: viaRegulars || !!channel, template };
}

export async function channelByPhoneNumberId(id) {
  const { rows: [c] } = await query(`SELECT c.*, row_to_json(t.*) AS tenant FROM tenant_channels c JOIN tenants t ON t.id=c.tenant_id WHERE c.phone_number_id=$1 AND c.status='ACTIVE'`, [id]);
  return c || null;
}

async function graphSend(channel, payload) {
  const token = decrypt(channel.access_token_enc);
  const res = await fetch(`https://graph.facebook.com/${config.whatsapp.graphVersion}/${channel.phone_number_id}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(metaError(json, res.status));
  return json?.messages?.[0]?.id || null;
}

/** "(#131030) Recipient phone number not in allowed list — add it in Meta → API Setup" instead of a bare 400. */
const HINTS = {
  190: 'access token expired or wrong — paste a permanent (System User) token on the WhatsApp page',
  100: 'phone number ID is wrong, or the token has no access to it',
  131030: 'app is in development mode: add this number under Meta → WhatsApp → API Setup → "To", or publish the app',
  131047: 'more than 24 hours since this person last messaged — only an approved template can be sent',
  131026: 'this number is not on WhatsApp or cannot receive messages',
  132001: 'template name / language does not exist or is not approved',
  133010: 'phone number is not registered with Cloud API yet',
};
export function metaError(json, httpStatus) {
  const e = json?.error || {};
  const code = e.code; const detail = e.error_data?.details;
  const hint = HINTS[code] || HINTS[e.error_subcode];
  return [`WhatsApp API ${httpStatus}${code ? ` (#${code})` : ''}: ${e.message || 'request failed'}`, detail, hint && `→ ${hint}`].filter(Boolean).join(' — ');
}

/**
 * Connection check for the WhatsApp page (testing report #2): is the token valid, does the
 * phone number ID belong to it, and is the server actually sending (live) or only saving (mock)?
 */
export async function checkChannel(tenantId) {
  const out = { sendMode: config.whatsapp.sendMode, problems: [] };
  clearTemplateCache();
  if (config.whatsapp.sendMode !== 'live') out.problems.push('Server is in MOCK mode: replies are saved in the log but never sent. Set WHATSAPP_SEND_MODE=live on the Loyvexa server and restart.');
  const { rows: [tenant] } = await query(`SELECT id, hub_business_id FROM tenants WHERE id=$1`, [tenantId]);
  out.viaRegulars = waViaRegulars(tenant);
  if (out.viaRegulars) { out.note = 'This brand sends through Loopdesk/Regulars — check the number there.'; }
  else {
    const channel = await channelForTenant(tenantId);
    if (!channel) out.problems.push('No WhatsApp number connected on this page.');
    else if (!channel.access_token_enc) out.problems.push('No access token saved.');
    else {
      try {
        const token = decrypt(channel.access_token_enc);
        const res = await fetch(`https://graph.facebook.com/${config.whatsapp.graphVersion}/${channel.phone_number_id}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,status`, { headers: { Authorization: `Bearer ${token}` } });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) out.problems.push(metaError(json, res.status));
        else out.number = json;
      } catch (e) { out.problems.push(`Could not reach Meta: ${e.message}`); }
    }
  }
  const { rows } = await query(`SELECT status, count(*)::int AS n, max(error) FILTER (WHERE status='FAILED') AS last_error FROM messages WHERE tenant_id=$1 AND direction='OUT' AND created_at > now() - interval '1 day' GROUP BY 1`, [tenantId]);
  out.last24h = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const lastErr = rows.find((r) => r.last_error)?.last_error;
  if (lastErr) out.problems.push(`Last failed send: ${lastErr}`);
  if (out.last24h.SENT && !out.last24h.DELIVERED && !out.last24h.READ && !out.viaRegulars) out.problems.push('Messages left the server (SENT) but Meta never reported DELIVERED. Check that the webhook URL below is subscribed to the "messages" field in Meta, and that the recipient is in the allowed list while the app is in development mode.');
  if (config.whatsapp.sendMode === 'live') {
    const missing = [];
    for (const key of TEMPLATE_KEYS) { const t = await resolveTemplate(tenantId, key).catch(() => null); if (t?.missing) missing.push(`${t.name} (${key})`); }
    if (missing.length) out.problems.push(`These templates are not approved, so those messages cannot be sent: ${missing.join(', ')}.`);
  }
  out.ok = out.problems.length === 0;
  return out;
}

async function record({ tenantId, participantId, to, body, payload, status, error, providerMsgId }) {
  const { rows: [m] } = await query(
    `INSERT INTO messages (tenant_id, participant_id, direction, peer, body, payload, status, error, provider_msg_id) VALUES ($1,$2,'OUT',$3,$4,$5,$6,$7,$8) RETURNING *`,
    [tenantId, participantId || null, to, body, payload || null, status, error || null, providerMsgId || null]);
  return m;
}

/**
 * Send through Regulars: POST {REGULARS_API_URL}/api/hub/tools/loyvexa/whatsapp/send
 * Bearer HS256 JWT (HUB_SECRET): iss "loyvexa", aud "regulars-hub", sub <hub business id>,
 * purpose "whatsapp-send", jti, 2 minutes. Body { to, message } where message is the
 * same WhatsApp Cloud API payload ({ type: 'text' | 'template', … }).
 * Regulars uses its own number + templates and its own STOP list, and answers
 * { messageId } (or an error, e.g. the person sent STOP).
 */
async function regularsSend(tenant, to, payload) {
  const token = jwt.sign({ purpose: 'whatsapp-send', jti: crypto.randomUUID() }, config.hub.secret,
    { algorithm: 'HS256', issuer: 'loyvexa', audience: config.hub.issuer, subject: tenant.hub_business_id, expiresIn: '2m' });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${config.regulars.apiUrl}/api/hub/tools/loyvexa/whatsapp/send`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, message: payload }), signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || json?.error || `Regulars WhatsApp ${res.status}`);
    return json?.messageId || null;
  } finally { clearTimeout(timer); }
}

/**
 * Testing report 2 #1: after START the reply still FAILED with "This person sent STOP", because
 * Regulars keeps its own STOP list for the shared number and Loyvexa only cleared its own flag.
 * Now Loyvexa tells Regulars too, BEFORE replying:
 *   POST {REGULARS_API_URL}/api/hub/tools/loyvexa/whatsapp/opt-in   (same signed token, purpose "whatsapp-opt-in")
 *   body { to: "9198…", optIn: true | false }  →  { ok: true }
 * Returns { ok, skipped?, error? } and never throws (a missing endpoint must not break the bot).
 */
export async function syncOptIn(tenantId, to, optIn) {
  const { rows: [tenant] } = await query(`SELECT id, hub_business_id FROM tenants WHERE id=$1`, [tenantId]);
  if (!waViaRegulars(tenant)) return { ok: true, skipped: 'own number' };
  if (config.whatsapp.sendMode !== 'live') return { ok: true, skipped: 'mock mode' };
  try {
    const token = jwt.sign({ purpose: 'whatsapp-opt-in', jti: crypto.randomUUID() }, config.hub.secret,
      { algorithm: 'HS256', issuer: 'loyvexa', audience: config.hub.issuer, subject: tenant.hub_business_id, expiresIn: '2m' });
    const res = await fetch(`${config.regulars.apiUrl}/api/hub/tools/loyvexa/whatsapp/opt-in`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, optIn: !!optIn }), signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return { ok: true };
    const json = await res.json().catch(() => ({}));
    return { ok: false, error: res.status === 404 ? 'Loopdesk does not have the opt-in endpoint yet (POST /api/hub/tools/loyvexa/whatsapp/opt-in)' : (json?.error?.message || json?.error || `Loopdesk ${res.status}`) };
  } catch (e) { return { ok: false, error: `Could not reach Loopdesk: ${e.message}` }; }
}

/**
 * Testing report 3 #5: always send to the full number with country code. A reply to "9814000102"
 * (no 91) is read by Meta as another country's number that never messaged us, and fails with
 * "Re-engagement message" even though the dealer wrote a minute ago.
 */
export const waNumber = (to) => normalizeMobile(to) || String(to || '').replace(/\D/g, '');

/** Makes a failed send's reason actionable (testing report 3 #3 and #5). */
async function explain(tenantId, to, message) {
  const msg = String(message || '');
  if (/re-?engagement|131047|24 ?hours?/i.test(msg)) {
    const { rows: [last] } = await query(`SELECT created_at FROM messages WHERE tenant_id=$1 AND peer=$2 AND direction='IN' ORDER BY created_at DESC LIMIT 1`, [tenantId, to]);
    const ago = last ? (Date.now() - new Date(last.created_at).getTime()) / 3600e3 : null;
    const when = last ? new Date(last.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null;
    return ago != null && ago < 24
      ? `${msg} → +${to} last messaged at ${when} (${ago < 1 ? 'under an hour' : `${Math.floor(ago)} h`} ago), so the 24-hour window was open. The reply went out from a different WhatsApp number than the one this person wrote to — check that Loopdesk sends Loyvexa replies from this business's own number.`
      : `${msg} → ${last ? `+${to} last messaged at ${when}, more than 24 hours ago` : `+${to} has never messaged this number`}: only an approved template can be sent.`;
  }
  if (/sent stop|opted.?out|stop to the business/i.test(msg)) {
    return `${msg} → Loopdesk still has +${to} on its STOP list. If they sent START, Loopdesk's opt-in did not go through: use Participants → "Unblock WhatsApp".`;
  }
  return msg;
}

async function send({ tenantId, participantId, to: rawTo, body, payload }) {
  const to = waNumber(rawTo);
  const { rows: [tenant] } = await query(`SELECT id, hub_business_id FROM tenants WHERE id=$1`, [tenantId]);
  if (waViaRegulars(tenant)) {
    if (config.whatsapp.sendMode !== 'live') return record({ tenantId, participantId, to, body, payload, status: 'MOCK' });
    try {
      const id = await regularsSend(tenant, to, payload);
      return record({ tenantId, participantId, to, body, payload, status: 'SENT', providerMsgId: id });
    } catch (e) {
      return record({ tenantId, participantId, to, body, payload, status: 'FAILED', error: await explain(tenantId, to, e.message) });
    }
  }
  const channel = await channelForTenant(tenantId);
  if (config.whatsapp.sendMode !== 'live' || !channel?.access_token_enc) {
    return record({ tenantId, participantId, to, body, payload, status: 'MOCK' });
  }
  try {
    const id = await graphSend(channel, { to, ...payload });
    return record({ tenantId, participantId, to, body, payload, status: 'SENT', providerMsgId: id });
  } catch (e) {
    return record({ tenantId, participantId, to, body, payload, status: 'FAILED', error: await explain(tenantId, to, e.message) });
  }
}

/** A message that was not sent at all (e.g. its template is not approved), kept with the reason. */
export const recordFailed = ({ tenantId, participantId, to, body, error }) =>
  record({ tenantId, participantId, to: waNumber(to), body, status: 'FAILED', error });

export const sendText = ({ tenantId, participantId, to, text }) =>
  send({ tenantId, participantId, to, body: text, payload: { type: 'text', text: { body: text, preview_url: true } } });

/** params: array of strings for {{1}}, {{2}}… in the template body */
export const sendTemplate = ({ tenantId, participantId, to, name, language = 'en', params = [], previewText, buttonParam }) =>
  send({
    tenantId, participantId, to, body: previewText || `[template:${name}] ${params.join(' | ')}`,
    payload: {
      type: 'template',
      template: {
        name, language: { code: language },
        components: [
          // Meta rejects an empty template parameter (#131008), e.g. an order with no DMS ref.
          ...(params.length ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p ?? '').trim() || '-' })) }] : []),
          ...(buttonParam ? [{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(buttonParam) }] }] : []),
        ],
      },
    },
  });

/** X-Hub-Signature-256 check (enabled when WHATSAPP_APP_SECRET is set). */
export function verifySignature(req) {
  if (!config.whatsapp.appSecret) return true;
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return false;
  const expected = `sha256=${crypto.createHmac('sha256', config.whatsapp.appSecret).update(req.rawBody || '').digest('hex')}`;
  return safeEqual(sig, expected);
}

/**
 * Testing report #8: approved WhatsApp templates for the campaign dropdown.
 *  - Brand with its own number: straight from Meta (needs the WhatsApp Business Account ID).
 *  - Loopdesk / Regulars brand: asks the hub (GET …/tools/loyvexa/whatsapp/templates, same signed
 *    token as sending). Until the hub has that endpoint, falls back to the fixed loyvexa_* names Regulars owns.
 * Returns { source, templates: [{ name, language, category, params, body }], note? }
 */
const countParams = (body = '') => new Set((body.match(/{{\s*\d+\s*}}/g) || [])).size;
export async function listTemplates(tenantId) {
  const { rows: [tenant] } = await query(`SELECT id, hub_business_id FROM tenants WHERE id=$1`, [tenantId]);
  if (waViaRegulars(tenant)) {
    try {
      const token = jwt.sign({ purpose: 'whatsapp-templates', jti: crypto.randomUUID() }, config.hub.secret,
        { algorithm: 'HS256', issuer: 'loyvexa', audience: config.hub.issuer, subject: tenant.hub_business_id, expiresIn: '2m' });
      const res = await fetch(`${config.regulars.apiUrl}/api/hub/tools/loyvexa/whatsapp/templates`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const json = await res.json();
        const list = json.templates || [];
        // If Loopdesk sends a status, keep only APPROVED; if it sends none, its list is approved-only.
        const hasStatus = list.some((t) => t.status);
        return { source: 'loopdesk', templates: list.filter((t) => !hasStatus || String(t.status).toUpperCase() === 'APPROVED').map((t) => ({ name: t.name, language: t.language || 'en', category: t.category || null, body: t.body || null, params: t.params ?? countParams(t.body) })) };
      }
    } catch { /* fall through */ }
    // Testing report 2 #6: these fixed names used to be offered as if approved, and a campaign ran
    // with loyvexa_scheme_bonus that Meta had not approved. Not verified = not selectable.
    const keys = ['otp', 'redemption.paid', 'redemption.failed', 'redemption.rejected', 'scheme.bonus', 'ai.slab', 'ai.mechanic'];
    return { source: 'unverified', templates: [], expected: keys.map((k) => regularsTemplateName(k)), note: `Could not confirm which templates are approved in Loopdesk, so none can be picked yet. Create and get these approved in Loopdesk → WhatsApp templates: ${keys.map((k) => regularsTemplateName(k)).join(', ')}.` };
  }
  const channel = await channelForTenant(tenantId);
  if (!channel?.access_token_enc) return { source: 'none', templates: [], note: 'Connect your WhatsApp number first.' };
  if (!channel.config?.wabaId) return { source: 'none', templates: [], note: 'Add your WhatsApp Business Account ID on the WhatsApp page to load approved templates.' };
  const token = decrypt(channel.access_token_enc);
  const out = [];
  let url = `https://graph.facebook.com/${config.whatsapp.graphVersion}/${channel.config.wabaId}/message_templates?status=APPROVED&fields=name,language,category,components&limit=200`;
  for (let page = 0; url && page < 5; page++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { source: 'meta', templates: out, note: metaError(json, res.status) };
    for (const t of json.data || []) {
      const body = (t.components || []).find((c) => c.type === 'BODY')?.text || '';
      out.push({ name: t.name, language: t.language, category: t.category, body, params: countParams(body) });
    }
    url = json.paging?.next || null;
  }
  return { source: 'meta', templates: out };
}

/**
 * Testing report 2 #6: a campaign may only use a template Meta / Loopdesk reports as APPROVED.
 * In mock mode (nothing is really sent) any name is allowed, so the flow can be tested.
 */
export async function assertApprovedTemplate(tenantId, name, language) {
  if (config.whatsapp.sendMode !== 'live') return null;
  const list = await listTemplates(tenantId);
  const t = list.templates.find((x) => x.name === name && (!language || !x.language || x.language === language))
    || list.templates.find((x) => x.name === name);
  if (!t) {
    const why = list.note ? ` ${list.note}` : list.templates.length ? ` Approved templates: ${list.templates.map((x) => x.name).join(', ')}.` : '';
    throw badRequest('TEMPLATE_NOT_APPROVED', `Template "${name}" is not approved on WhatsApp, so the campaign was not created.${why}`);
  }
  return t;
}

/**
 * Testing report 3 #4: every welcome message failed with "(#132001) Template name does not exist in
 * the translation" — Loyvexa guessed the name loyvexa_participant_created in language "en", which
 * did not match the template in Meta. Now the template is looked up in the approved list
 * (Loopdesk or Meta) by name and its real language code is used (hi, en, en_US…). If it is not
 * approved, nothing is sent to Meta and the message is kept as FAILED with the exact fix.
 *
 * Per brand override: tenants.settings.waTemplates = { "participant.created": { name, language } }.
 * Returns null (no template configured), { name, language } or { missing: true, name, error }.
 */
const TEMPLATE_ALIASES = { 'participant.created': ['loyvexa_welcome', 'loyvexa_participant_welcome', 'welcome'] };
export const TEMPLATE_KEYS = ['participant.created', 'otp', 'redemption.paid', 'redemption.failed', 'redemption.rejected', 'scheme.bonus', 'purchase.recorded', 'order.sent', 'order.failed', 'points.expiring', 'ai.slab', 'ai.mechanic'];
const approvedCache = new Map();
async function approvedTemplates(tenantId) {
  const hit = approvedCache.get(tenantId);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.list;
  const list = await listTemplates(tenantId).catch((e) => ({ source: 'error', templates: [], note: e.message }));
  approvedCache.set(tenantId, { at: Date.now(), list });
  return list;
}
export const clearTemplateCache = () => approvedCache.clear();

export async function resolveTemplate(tenantId, key) {
  const { rows: [tenant] } = await query(`SELECT settings FROM tenants WHERE id=$1`, [tenantId]);
  const sender = await senderFor(tenantId);
  const override = tenant?.settings?.waTemplates?.[key];
  const want = override ? (typeof override === 'string' ? { name: override } : override) : sender.template(key);
  if (!want?.name) return null;
  if (config.whatsapp.sendMode !== 'live') return { name: want.name, language: want.language || 'en' };
  const list = await approvedTemplates(tenantId);
  if (!['loopdesk', 'meta'].includes(list.source)) return { name: want.name, language: want.language || 'en' }; // cannot verify: send as configured
  const names = [want.name, ...((!override && want.guessed && TEMPLATE_ALIASES[key]) || [])];
  const match = list.templates.find((t) => t.name === want.name && (!want.language || t.language === want.language))
    || names.map((n) => list.templates.find((t) => t.name === n)).find(Boolean);
  if (match) return { name: match.name, language: match.language || want.language || 'en' };
  const where = list.source === 'loopdesk' ? 'Loopdesk → WhatsApp templates' : 'Meta → WhatsApp Manager → Message templates';
  return {
    missing: true, name: want.name,
    error: `Not sent: template "${want.name}" is not approved on WhatsApp (#132001 avoided). Create it in ${where} and get it approved${list.templates.length ? `, or set this brand's waTemplates["${key}"] to one of: ${list.templates.map((t) => `${t.name} (${t.language})`).join(', ')}` : ''}.`,
  };
}
