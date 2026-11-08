import { query } from '../../db/pool.js';
import { config } from '../../config.js';
import { channelForTenant, sendText, sendTemplate } from '../whatsapp.js';

/**
 * Business-initiated WhatsApp for the AI Channel Manager.
 * Meta allows free text only within 24 hours of the person's last message;
 * otherwise an approved template is needed: tenant_channels.config.templates[eventType]
 * = { name, language }. In mock mode everything goes as text, so demos work.
 *
 * Returns { status: 'sent-text' | 'sent-template' | 'no-template' | 'failed', messageId? }.
 */
export async function sendBusiness({ tenantId, participantId = null, to, eventType, text, params = [] }) {
  const { rows: [recent] } = await query(
    `SELECT 1 FROM messages WHERE tenant_id=$1 AND peer=$2 AND direction='IN' AND created_at > now() - interval '23 hours' LIMIT 1`, [tenantId, to]);
  const channel = await channelForTenant(tenantId);
  if (recent || config.whatsapp.sendMode !== 'live') {
    const m = await sendText({ tenantId, participantId, to, text });
    return { status: m.status === 'FAILED' ? 'failed' : 'sent-text', messageId: m.id, error: m.error };
  }
  const tpl = channel?.config?.templates?.[eventType];
  if (!tpl) return { status: 'no-template' };
  const m = await sendTemplate({ tenantId, participantId, to, name: tpl.name, language: tpl.language || 'en', params: params.map((p) => String(p).replace(/\s+/g, ' ').slice(0, 900)), previewText: text });
  return { status: m.status === 'FAILED' ? 'failed' : 'sent-template', messageId: m.id, error: m.error };
}

/** Template body params per AI event, for the brand's Meta templates. */
export const TEMPLATE_PARAMS = {
  'ai.reorder': '{{1}} name, {{2}} last order date, {{3}} items (one line)',
  'ai.slab': '{{1}} name, {{2}} scheme, {{3}} amount still needed, {{4}} reward, {{5}} last date',
  'ai.mechanic': '{{1}} name, {{2}} points balance, {{3}} scheme line',
  'ai.payment': '{{1}} name, {{2}} overdue amount, {{3}} oldest due date',
  'ai.brief': '{{1}} brand, {{2}} number of actions, {{3}} total value — owner replies PLAN to see them',
  'ai.report': '{{1}} brand, {{2}} actions done, {{3}} revenue influenced',
};
