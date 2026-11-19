# Korvo (formerly Royal) ↔ Loyvexa integration

> **Status (Nov 2026):** built. Korvo side is on `royalSoftwareBackend` branch `feature/loyvexa-bundle` (`services/loyvexa.js`, `routes/integrations/loyvexaRoute.js`) and the Rewards tab on `royalappfrontend` branch `feature/loyvexa-bundle`. Set it up with **Connect Korvo** in the Loyvexa console instead of copying keys; the manual steps below still work. New since this doc: Korvo also pushes overdue outstanding nightly to `POST /api/connect/outstanding`.

Loyvexa and Korvo are two products. They talk only over HTTP. Nothing in this file needs a shared database.

```
Korvo ──(order delivered / returned / cancelled)──▶ POST /api/connect/royal          → dealer purchase points
Korvo ──(dealers, products)────────────────────────▶ POST /api/connect/parties | /products
Korvo backend ──(dealer ref)───────────────────────▶ POST /api/connect/participant-token → 1-hour token
Korvo app "Rewards" tab ──(token, via Korvo backend)▶ GET  /api/p/me | /api/p/schemes | /api/p/ledger
Loyvexa ──(WhatsApp order)─────────────────────────▶ POST {KORVO_BASE_URL}/api/v1/orders/external
```

Every Loyvexa call uses the connector API key: `X-Api-Key: lvx_…`. Create the key in Console → Connectors → **Korvo (Royal) DMS**. To use the Rewards tab, enable the token exchange on that connector:
`PATCH /api/admin/connectors/:id  {"config":{"allowTokenExchange":true,"earnOn":"delivered"}}`

## 1. To build in the Korvo backend (`royalSoftwareBackend`)

### a) Order status webhook (required)
Every time an order moves to `approved`, `delivered`, `cancelled` or `returned`, POST it to Loyvexa. Retry with backoff on errors. Loyvexa ignores duplicates, so retries are safe.

```js
// models/order/orderModel.js — after the schema definition
import axios from 'axios';
const LOYVEXA = process.env.LOYVEXA_URL;        // https://loyvexa.wayneesolutions.com
const KEY = process.env.LOYVEXA_CONNECTOR_KEY;  // lvx_…

orderSchema.post('save', async function (doc) {
  if (!['approved', 'delivered', 'cancelled', 'returned'].includes(doc.status)) return;
  try {
    await axios.post(`${LOYVEXA}/api/connect/royal`, { event: `order.${doc.status}`, order: doc.toObject() },
      { headers: { 'X-Api-Key': KEY }, timeout: 10000 });
  } catch (e) { console.error('loyvexa webhook failed', e.message); /* TODO: push to a retry queue */ }
});
```
Loyvexa reads these fields: `orderNumber`, `orderDate`, `deliveryDate`, `dealerId` (or `customerId`), `dealerName`, `customerMobile`, `items[].productCode`, `items[].quantity`, `items[].taxableValue` (or `totalPrice`), and `taxableValueTotal`.

### b) Master sync (recommended, nightly + on change)
- Dealers: `POST /api/connect/parties` with `[{ _id, name, mobile, gstin, role: 'dealers'|'distibutors'|'subdealer', address: { city, state, pincode } }]`
- Products: `POST /api/connect/products` with `[{ productCode, productName, category, price, mrp }]`. `price` is the dealer price used for WhatsApp ordering.

### c) External order endpoint (for WhatsApp ordering)
Add `POST /api/v1/orders/external`, protected by `X-Api-Key` (`KORVO_API_KEY`, the same value set in Loyvexa's env). Request body:
```json
{ "source": "loyvexa-whatsapp", "externalOrderId": "WA-261104-AA7F", "brand": "demo-auto",
  "dealerExternalRef": "<dealer _id>", "dealerMobile": "919814000101", "dealerName": "Gill Auto Store",
  "items": [{ "productCode": "BRK-PAD-110", "productName": "Brake Pad Set", "quantity": 20, "unitPrice": 450 }],
  "totalAmount": 22500 }
```
Create the order as `pending_approval` under that dealer, so it follows the normal approval chain. Respond with `{ "orderNumber": "<korvo order no>" }`. Treat `Idempotency-Key` (the Loyvexa order id) as unique. When the order is delivered, webhook (a) awards the points.

### d) Rewards tab in the Korvo app (`royalappfrontend`)
1. Korvo backend route `GET /api/v1/rewards/session`, for logged-in dealers and sub-dealers only. It calls `POST {LOYVEXA}/api/connect/participant-token` with `{ externalRef: user._id }` and returns `{ token }`.
2. The app calls Loyvexa with that token: `GET /api/p/me` (balance), `GET /api/p/schemes` (progress bars), `GET /api/p/ledger`, and `POST /api/p/redeem` for cash-out.
3. The connector key **never** goes into the mobile app.

## 2. Turning on WhatsApp ordering for a brand
`PATCH /api/admin/tenant {"settings":{"orderDms":"korvo"}}` and set `KORVO_BASE_URL` and `KORVO_API_KEY` in Loyvexa's env.
- `orderDms: "none"`: orders are only recorded; the brand team clicks "Mark processed" in Console → Orders.
- `orderDms: "mock"`: demo mode.
