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

// Mock = TEST MODE: nothing is dialled. Testing report 2 #3: it used to invent an outcome
// ("Mock call: wrong number") that looked like a real call. Now it records no outcome, unless
// CALL_MOCK_OUTCOMES=1 (automated tests only), which picks one from the number's last digit.
const mock = {
  name: 'mock',
  async startCall({ callId, to }) {
    const providerCallId = `MOCKCALL-${callId}`;
    if (process.env.CALL_MOCK_OUTCOMES !== '1') {
      return { providerCallId, result: { testMode: true, outcome: null, summary: 'TEST MODE — no real call was placed (CALL_PROVIDER=mock on the server)' } };
    }
    const outcome = OUTCOMES[Number(String(to).slice(-1)) || 0];
    return { providerCallId, result: { testMode: true, outcome, summary: `TEST MODE — simulated outcome: ${outcome.toLowerCase().replace('_', ' ')}` } };
  },
  parseWebhook(req) {
    const b = req.body || {};
    return b.outcome ? { callId: b.callId, providerCallId: b.providerCallId, outcome: b.outcome, summary: b.summary } : null;
  },
};

/**
 * Testing report 3 #1: WayneRing reported calls as "NO ANSWER · Nobody spoke on the call" that never
 * rang any phone. A missing outcome used to become NO_ANSWER. Now the report is read for what really
 * happened, and a call is NO_ANSWER only when there is proof that the phone rang (carrier said
 * busy / no-answer, or the call lasted some seconds). Anything else without an outcome is
 * FAILED – not dialled, with WayneRing's own status / ended reason as the reason.
 *
 * Returns { outcome, failed, notDialled, providerStatus, reason }.
 */
const NOT_DIALLED = /fail|error|invalid|not[-_ ]?dial|could[-_ ]?not|unable|rejected|no[-_ ]?(phone|number|credit|balance)|insufficient|unauthori|forbidden|blocked|sip[-_]|twilio|plivo|vonage|telnyx|exotel|dnd|trai|cancel|abort|timeout[-_ ]?before|assistant[-_ ]?(not|error)|start[-_ ]?error|not[-_ ]?connected|unreachable|bad[-_ ]?request/i;
const RANG_NO_PICKUP = /did[-_ ]?not[-_ ]?answer|no[-_ ]?answer|not[-_ ]?answered|busy|voicemail|ring[-_ ]?timeout|declined|missed/i;
const num = (v) => (v == null || v === '' ? null : Number(v));

export function classifyCallReport(b = {}) {
  const outcome = String(b.outcome || b.disposition || b.result?.outcome || '').toUpperCase().replace(/[\s-]+/g, '_');
  const status = String(b.status || b.call_status || b.callStatus || '').toLowerCase();
  const ended = String(b.ended_reason || b.endedReason || b.end_reason || b.hangup_cause || b.hangupCause || b.dial_status || b.dialStatus || '').toLowerCase();
  const duration = num(b.duration_seconds ?? b.durationSeconds ?? b.duration ?? b.call_duration ?? b.billsec);
  const answered = b.answered === true || !!(b.answered_at || b.answeredAt);
  const errorText = b.error?.message || b.error_message || b.errorMessage || (typeof b.error === 'string' ? b.error : '') || '';
  const providerStatus = [status, ended].filter(Boolean).join(' / ') || null;
  const summary = b.summary || b.transcript_summary || b.analysis?.summary || null;

  const explicitFail = ['failed', 'error', 'not_dialled', 'not-dialled', 'not_dialed', 'canceled', 'cancelled', 'rejected'].includes(status);
  if (explicitFail || (ended && NOT_DIALLED.test(ended) && !RANG_NO_PICKUP.test(ended)) || errorText) {
    return { outcome: null, failed: true, notDialled: !answered && !(duration > 0), providerStatus, reason: errorText || ended || status || 'WayneRing reported a failure', summary };
  }
  if (outcome && outcome !== 'NO_ANSWER') return { outcome, failed: false, notDialled: false, providerStatus, summary };
  // NO_ANSWER (or no outcome at all) only stands when there is proof that the phone rang.
  const rang = answered || duration > 0 || RANG_NO_PICKUP.test(ended) || ['no-answer', 'no_answer', 'busy'].includes(status);
  if (rang) return { outcome: 'NO_ANSWER', failed: false, notDialled: false, providerStatus, summary };
  return {
    outcome: null, failed: true, notDialled: true, providerStatus,
    reason: `WayneRing gave no proof the phone rang (status: ${status || '—'}, ended reason: ${ended || '—'}, duration: ${duration ?? '—'}s)`, summary,
  };
}

/**
 * WayneRing outbound calls API (Wayneesolutions/aivoicebackend PR #34):
 *   POST {WAYNERING_BASE_URL}/api/v1/outbound-calls  (per-receptionist API key)
 * Env: CALL_PROVIDER=waynering, WAYNERING_BASE_URL, WAYNERING_API_KEY, CALL_WEBHOOK_SECRET.
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
      signal: AbortSignal.timeout(20000),
    });
    const j = await res.json().catch(() => ({}));
    const id = j.id || j.call_id || j.callId || j.data?.id || null;
    const status = String(j.status || j.data?.status || '').toLowerCase() || null;
    console.log(`[calls] WayneRing start loyvexa=${callId} to=+${to} http=${res.status} waynering_id=${id || '—'} status=${status || '—'}`);
    if (!res.ok) throw new Error(`not dialled — WayneRing HTTP ${res.status}: ${j?.error?.message || j?.error || j?.message || 'request refused'}`);
    if (!id) throw new Error('not dialled — WayneRing accepted the request but returned no call ID');
    if (status && ['failed', 'error', 'rejected', 'not_dialled', 'not-dialled'].includes(status)) {
      throw Object.assign(new Error(`not dialled — WayneRing status "${status}"${j.reason || j.error ? `: ${j.reason || j.error?.message || j.error}` : ''}`), { providerCallId: id, providerStatus: status });
    }
    return { providerCallId: String(id), providerStatus: status };
  },
  parseWebhook(req) {
    if (config.calls.webhookSecret) {
      const sig = req.headers['x-waynering-signature'] || '';
      const expected = crypto.createHmac('sha256', config.calls.webhookSecret).update(req.rawBody || '').digest('hex');
      if (!safeEqual(sig, expected)) return null;
    }
    const b = req.body || {};
    const c = classifyCallReport(b);
    return {
      callId: b.metadata?.loyvexa_call_id || b.loyvexa_call_id, providerCallId: b.id || b.call_id || b.callId,
      outcome: c.outcome, summary: c.summary, failed: c.failed, notDialled: c.notDialled, reason: c.reason,
      providerStatus: c.providerStatus, raw: b,
    };
  },
};

const providers = { mock, waynering };
export const getCallProvider = (name = config.calls.provider) => {
  const p = providers[name];
  if (!p) throw new Error(`Unknown call provider: ${name}`);
  return p;
};
