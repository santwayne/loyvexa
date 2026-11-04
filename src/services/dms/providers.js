import { config } from '../../config.js';

/**
 * DMS order push. Contract:
 *   push({ order, participant, tenant }) -> { ref }   // the order number in the DMS
 *
 * korvo: Korvo (formerly Royal) DMS — POST {KORVO_BASE_URL}/api/v1/orders/external
 *   Korvo creates the order as `pending_approval` so it goes through its normal hierarchy approval.
 *   When Korvo later delivers it, its webhook to /api/connect/royal awards purchase points as usual.
 *   The endpoint has to be added on the Korvo side (see docs/korvo-integration.md).
 */
const mock = {
  name: 'mock',
  async push({ order }) { return { ref: `KRV-${order.order_no}` }; },
};

const korvo = {
  name: 'korvo',
  async push({ order, participant, tenant }) {
    const res = await fetch(`${config.korvo.baseUrl.replace(/\/$/, '')}/api/v1/orders/external`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.korvo.apiKey, 'Idempotency-Key': order.id },
      body: JSON.stringify({
        source: 'loyvexa-whatsapp', externalOrderId: order.order_no, brand: tenant.slug,
        dealerExternalRef: participant.external_ref, dealerMobile: participant.mobile, dealerName: participant.name,
        items: order.items.map((i) => ({ productCode: i.sku, productName: i.name, quantity: i.qty, unitPrice: i.pricePaise / 100 })),
        totalAmount: Number(order.total_paise) / 100,
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.message || `Korvo ${res.status}`);
    return { ref: j.orderNumber || j.data?.orderNumber };
  },
};

// none: Loyvexa only records the order; the brand team processes it from the console.
const none = { name: 'none', async push() { return { ref: null }; } };

const providers = { mock, korvo, none };
export const getDms = (name) => providers[name] || mock;
