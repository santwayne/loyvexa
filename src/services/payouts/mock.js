// Development provider: pays instantly. Any UPI ID containing "fail" is rejected,
// so the failure + refund path can be tested end to end.
export default {
  name: 'mock',
  async pay({ redemptionId, upiId }) {
    if (/fail/i.test(upiId)) return { status: 'FAILED', failureReason: 'Mock: invalid VPA' };
    return { status: 'PAID', providerRef: `MOCK-${redemptionId.slice(0, 8)}` };
  },
  parseWebhook(req) {
    const { redemptionId, providerRef, status, failureReason } = req.body || {};
    return status ? { redemptionId, providerRef, status, failureReason } : null;
  },
};
