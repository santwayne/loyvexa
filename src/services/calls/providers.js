import crypto from 'node:crypto';
import { config } from '../../config.js';
import { safeEqual } from '../../lib/crypto.js';

/**
 * Call provider contract:
 *   startCall({ callId, to, language, firstMessage, instructions, variables }) ->
 *     { providerCallId, result?: { outcome, summary } }   // result = finished synchronously (mock)
 *   parseWebhook(req) -> { callId?, providerCallId?, outcome, summary, failed? } | null
 */
const OUTCOMES = ['INTERESTED', 'INTERESTED', 'INTERESTED', 'INTERESTED', 'NOT_INTERESTED', 'NOT_INTERESTED', 'NO_ANSWER', 'NO_ANSWER', 'CALL_LATER', 'WRONG_NUMBER'];

// Deterministic mock: outcome from the number's last digit, so tests and demos are repeatable.
const mock = {
  name: 'mock',
  async startCall({ callId, to }) {
    const outcome = OUTCOMES[Number(String(to).slice(-1)) || 0];
    return { providerCallId: `MOCKCALL-${callId}`, result: { outcome, summary: `Mock call: ${outcome.toLowerCase().replace('_', ' ')}` } };
  },
  parseWebhook(req) {
    const b = req.body || {};
    return b.outcome ? { callId: b.callId, providerCallId: b.providerCallId, outcome: b.outcome, summary: b.summary } : null;
  },
};

/**
 * WayneRing (aicalling.wayneesolutions.com) — outbound call via its API.
 * Env: CALL_PROVIDER=waynering, WAYNERING_BASE_URL, WAYNERING_API_KEY, CALL_WEBHOOK_SECRET.
 * Endpoint and field names are a contract proposal: confirm against the WayneRing API before going live.
 * India outbound commercial calls need a TRAI 140-series number on the WayneRing side.
 */
const waynering = {
  name: 'waynering',
  async startCall({ callId, to, language, firstMessage, instructions, variables }) {
    const res = await fetch(`${config.calls.wayneringBaseUrl.replace(/\/$/, '')}/api/v1/outbound-calls`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.calls.wayneringApiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': callId },
      body: JSON.stringify({
        to: `+${to}`, language, first_message: firstMessage, instructions, variables,
        metadata: { loyvexa_call_id: callId },
        webhook_url: `${config.publicBaseUrl}/api/webhooks/calls/waynering`,
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.error || `WayneRing ${res.status}`);
    return { providerCallId: j.id || j.call_id };
  },
  parseWebhook(req) {
    if (config.calls.webhookSecret) {
      const sig = req.headers['x-waynering-signature'] || '';
      const expected = crypto.createHmac('sha256', config.calls.webhookSecret).update(req.rawBody || '').digest('hex');
      if (!safeEqual(sig, expected)) return null;
    }
    const b = req.body || {};
    const outcome = String(b.outcome || b.disposition || '').toUpperCase();
    return { callId: b.metadata?.loyvexa_call_id, providerCallId: b.id || b.call_id, outcome: outcome || 'NO_ANSWER', summary: b.summary || b.transcript_summary || null, failed: b.status === 'failed' };
  },
};

const providers = { mock, waynering };
export const getCallProvider = (name = config.calls.provider) => {
  const p = providers[name];
  if (!p) throw new Error(`Unknown call provider: ${name}`);
  return p;
};
