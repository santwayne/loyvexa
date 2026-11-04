import { config } from '../../config.js';
import mock from './mock.js';
import razorpayx from './razorpayx.js';

/**
 * Payout provider contract:
 *   pay({ redemptionId, amountPaise, upiId, name, mobile }) ->
 *     { status: 'PAID' | 'PROCESSING' | 'FAILED', providerRef?, failureReason? }
 *   parseWebhook(req) -> { redemptionId?, providerRef, status, failureReason? } | null
 *
 * PROCESSING means the provider accepted it and will confirm via webhook.
 */
const providers = { mock, razorpayx };

export function getProvider(name = config.payoutProvider) {
  const p = providers[name];
  if (!p) throw new Error(`Unknown payout provider: ${name}`);
  return p;
}
