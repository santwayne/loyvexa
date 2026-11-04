import crypto from 'node:crypto';

/**
 * RazorpayX Payouts (UPI) — skeleton. Needs a RazorpayX current account + KYC.
 * Flow: create Contact -> create Fund Account (vpa) -> create Payout (mode UPI).
 * Final status arrives on webhook (payout.processed / payout.reversed / payout.failed).
 *
 * Env: RAZORPAYX_KEY_ID, RAZORPAYX_KEY_SECRET, RAZORPAYX_ACCOUNT_NUMBER, RAZORPAYX_WEBHOOK_SECRET
 * Verify endpoints/fields against current RazorpayX docs before going live.
 */
const BASE = 'https://api.razorpay.com/v1';

async function call(path, body) {
  const auth = Buffer.from(`${process.env.RAZORPAYX_KEY_ID}:${process.env.RAZORPAYX_KEY_SECRET}`).toString('base64');
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', 'X-Payout-Idempotency': body.reference_id || '' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.description || `RazorpayX ${res.status}`);
  return json;
}

export default {
  name: 'razorpayx',
  async pay({ redemptionId, amountPaise, upiId, name, mobile }) {
    try {
      const contact = await call('/contacts', { name: name || 'Participant', contact: mobile, type: 'vendor', reference_id: `c-${mobile}` });
      const fa = await call('/fund_accounts', { contact_id: contact.id, account_type: 'vpa', vpa: { address: upiId } });
      const payout = await call('/payouts', {
        account_number: process.env.RAZORPAYX_ACCOUNT_NUMBER,
        fund_account_id: fa.id, amount: amountPaise, currency: 'INR', mode: 'UPI',
        purpose: 'cashback', queue_if_low_balance: true, reference_id: redemptionId,
        narration: 'Loyalty reward',
      });
      const status = payout.status === 'processed' ? 'PAID' : ['failed', 'rejected', 'reversed', 'cancelled'].includes(payout.status) ? 'FAILED' : 'PROCESSING';
      return { status, providerRef: payout.id, failureReason: payout.failure_reason || undefined };
    } catch (e) {
      return { status: 'FAILED', failureReason: e.message };
    }
  },
  parseWebhook(req) {
    const sig = req.headers['x-razorpay-signature'];
    const expected = crypto.createHmac('sha256', process.env.RAZORPAYX_WEBHOOK_SECRET || '').update(req.rawBody || '').digest('hex');
    if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const p = req.body?.payload?.payout?.entity;
    if (!p) return null;
    const map = { processed: 'PAID', reversed: 'FAILED', failed: 'FAILED', rejected: 'FAILED', cancelled: 'FAILED' };
    if (!map[p.status]) return null;
    return { redemptionId: p.reference_id, providerRef: p.id, status: map[p.status], failureReason: p.failure_reason };
  },
};
