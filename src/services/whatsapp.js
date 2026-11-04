import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { decrypt, safeEqual } from '../lib/crypto.js';

/**
 * WhatsApp Cloud API sender. One number per brand (tenant_channels).
 * WHATSAPP_SEND_MODE=mock stores outgoing messages in `messages` without calling Meta,
 * so the whole bot can be tested before a number is approved.
 *
 * Meta rule: free-form text only within 24h of the user's last message.
 * Anything business-initiated (payout done, scheme bonus, OTP) must use an approved template.
 */
export async function channelForTenant(tenantId) {
  const { rows: [c] } = await query(`SELECT * FROM tenant_channels WHERE tenant_id=$1 AND channel='WHATSAPP' AND status='ACTIVE'`, [tenantId]);
  return c || null;
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
  if (!res.ok) throw new Error(json?.error?.message || `WhatsApp API ${res.status}`);
  return json?.messages?.[0]?.id || null;
}

async function record({ tenantId, participantId, to, body, payload, status, error, providerMsgId }) {
  const { rows: [m] } = await query(
    `INSERT INTO messages (tenant_id, participant_id, direction, peer, body, payload, status, error, provider_msg_id) VALUES ($1,$2,'OUT',$3,$4,$5,$6,$7,$8) RETURNING *`,
    [tenantId, participantId || null, to, body, payload || null, status, error || null, providerMsgId || null]);
  return m;
}

async function send({ tenantId, participantId, to, body, payload }) {
  const channel = await channelForTenant(tenantId);
  if (config.whatsapp.sendMode !== 'live' || !channel?.access_token_enc) {
    return record({ tenantId, participantId, to, body, payload, status: 'MOCK' });
  }
  try {
    const id = await graphSend(channel, { to, ...payload });
    return record({ tenantId, participantId, to, body, payload, status: 'SENT', providerMsgId: id });
  } catch (e) {
    return record({ tenantId, participantId, to, body, payload, status: 'FAILED', error: e.message });
  }
}

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
          ...(params.length ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) }] : []),
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
