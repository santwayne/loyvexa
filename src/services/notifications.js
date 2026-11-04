import { query } from '../db/pool.js';
import { config } from '../config.js';
import { channelForTenant, sendText, sendTemplate } from './whatsapp.js';
import { appLink } from './bot.js';
import { getTenant } from './tenants.js';

/**
 * Turns outbox events into WhatsApp messages.
 * Inside Meta's 24h window (participant messaged us recently) we send free text.
 * Outside it we need an approved template: tenant_channels.config.templates[eventType] = { name, language }.
 * Template body params are documented per event below; create matching templates in Meta Business Manager.
 */
const rupee = (paise) => `₹${(Number(paise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const BUILDERS = {
  // params: {{1}} name, {{2}} amount, {{3}} upi
  'redemption.paid': async (e, p) => ({ text: `✅ ${rupee(e.payload.amountPaise)} aapke UPI (${p.upi_id}) pe bhej diye gaye hain. Dhanyavaad 🙏`, params: [p.name || '', rupee(e.payload.amountPaise), p.upi_id || ''] }),
  // params: {{1}} name, {{2}} reason
  'redemption.failed': async (e, p) => ({ text: `⚠️ Aapka payment nahi ho paya (${e.payload.reason || 'UPI issue'}). Points wapas aapke wallet mein aa gaye hain. UPI ID check karke dobara try karo.`, params: [p.name || '', e.payload.reason || 'UPI issue'] }),
  // params: {{1}} name, {{2}} points, {{3}} scheme
  'scheme.bonus': async (e, p) => ({ text: `🏆 Badhai ho${p.name ? ` ${p.name}` : ''}! *${e.payload.schemeName}* mein aapko *${Number(e.payload.points).toLocaleString('en-IN')} bonus points* mile.`, params: [p.name || '', String(e.payload.points), e.payload.schemeName] }),
  // params: {{1}} name, {{2}} amount, {{3}} points
  'purchase.recorded': async (e, p) => (e.payload.points === 0 ? null : e.payload.points > 0
    ? { text: `🧾 Aapki purchase ${rupee(e.payload.totalPaise)} record ho gayi. *+${e.payload.points} points* mile.`, params: [p.name || '', rupee(e.payload.totalPaise), String(e.payload.points)] }
    : { text: `🧾 Return ${rupee(e.payload.totalPaise)} record hua. ${Math.abs(e.payload.points)} points adjust kiye gaye.`, params: [p.name || '', rupee(e.payload.totalPaise), String(e.payload.points)] }),
  // params: {{1}} name, {{2}} brand ; button: app link suffix
  'participant.created': async (e, p, tenant) => (e.payload.source === 'self_signup' ? null
    : { text: `Namaste${p.name ? ` ${p.name}` : ''} 🙏 *${tenant.name} Rewards* mein aapka swagat hai!\nHar purchase aur har scan pe points milenge.\nApp: ${appLink(tenant)}\nKuch bhi poochna ho toh yahan *menu* likho.`, params: [p.name || '', tenant.name] }),
};

export async function deliverEvent(evt) {
  const build = BUILDERS[evt.type];
  if (!build || !evt.payload?.participantId) return 'skipped';
  const channel = await channelForTenant(evt.tenant_id);
  if (!channel && config.whatsapp.sendMode === 'live') return 'no-channel';
  const { rows: [p] } = await query(`SELECT * FROM participants WHERE id=$1`, [evt.payload.participantId]);
  if (!p || p.status !== 'ACTIVE') return 'skipped';
  const tenant = await getTenant(evt.tenant_id);
  const msg = await build(evt, p, tenant);
  if (!msg) return 'skipped';

  const { rows: [recent] } = await query(
    `SELECT 1 FROM messages WHERE participant_id=$1 AND direction='IN' AND created_at > now() - interval '23 hours' LIMIT 1`, [p.id]);
  const tpl = channel?.config?.templates?.[evt.type];
  if (recent || config.whatsapp.sendMode !== 'live') {
    await sendText({ tenantId: evt.tenant_id, participantId: p.id, to: p.mobile, text: msg.text });
    return 'sent-text';
  }
  if (!tpl) return 'no-template';
  await sendTemplate({ tenantId: evt.tenant_id, participantId: p.id, to: p.mobile, name: tpl.name, language: tpl.language || 'en', params: msg.params, previewText: msg.text });
  return 'sent-template';
}
