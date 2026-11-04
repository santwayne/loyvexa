# Loyvexa: Channel Loyalty Platform (Phase 1)

Loyvexa is a loyalty platform for manufacturers. A mechanic, electrician or retailer scans the QR code on a genuine product, earns points, and cashes them out to UPI. Anyone can scan the same QR with a normal phone camera to check whether the product is genuine.

It runs on its own. Phase 2 connects it to **Royal** (DMS + Tally), **Regulars** (WhatsApp engine) and **WayneRing** (AI calls) through the `events` outbox table.

## What's in Phase 1

| Module | Details |
|---|---|
| Multi-brand (tenants) | One deployment serves many manufacturers, with brand color and logo. Each brand has its own rules. |
| Admin roles | `SUPER_ADMIN` (Wayne E Solutions), `TENANT_ADMIN`, `TENANT_STAFF` |
| Participants | Dealer, distributor, retailer, mechanic, electrician, plumber, contractor, painter, carpenter. Mobile OTP login, self-signup, parent dealer link, `external_ref` for the Royal/Tally id. |
| Products | Points per scan, with per-type overrides (e.g. mechanic 20, retailer 5) |
| QR batches | Up to 100k unique codes per batch. 12-char Crockford base32 codes (60-bit, unguessable). CSV export for label printers. Void a batch. |
| Scan-to-earn | Code is claimed atomically, so it pays exactly once even under concurrent scans. Points credited through the ledger. |
| Counterfeit check | `/q/<code>` landing page plus `/api/public/verify/<code>`. Every check is logged for the brand. |
| Points ledger | Append-only, idempotent (unique `type+ref`). Wallet = sum of ledger, verified in tests. |
| UPI payouts | Request → hold → approve → pay. Failure or reject refunds automatically. Double-approve is safe. Pluggable provider (`mock`, `razorpayx` skeleton) plus webhook. |
| Fraud rules | Daily scan limit, burst limit, auto-pause after repeated invalid scans, someone-else's-code attempts, shared-device detection. Flags go to the admin queue. |
| Brand console | `/admin/`: dashboard, products, QR batches, participants, redemptions, fraud flags, settings |
| Mechanic app (PWA) | `/app/?brand=<slug>`: Hindi/English, camera scan (BarcodeDetector + jsQR fallback), manual code entry, balance, history, UPI cash-out. Installable, no Play Store needed. |

## Run locally

```bash
cp .env.example .env              # edit DATABASE_URL if needed
npm install
npm run seed:demo                 # migrations + super admin + "demo-auto" brand
npm run dev                       # http://localhost:4000
```

Or with Docker: `docker compose up --build`, then `docker compose exec api node scripts/seed.js --demo`.

Logins (change them right away):
- Super admin: `admin@wayneesolutions.com` / `ChangeMe@123`
- Demo brand: `brand@demo-auto.in` / `Demo@12345`

Pages:
- Brand console: http://localhost:4000/admin/
- Mechanic app: http://localhost:4000/app/?brand=demo-auto (OTP shows on screen in dev mode)
- QR landing: `http://localhost:4000/q/<CODE>`

End-to-end test (28 checks, including concurrency and ledger integrity):
```bash
OTP_RATE_LIMIT_PER_MINUTE=1000 VERIFY_RATE_LIMIT_PER_MINUTE=1000 npm run dev   # terminal 1
npm run test:e2e                                                                # terminal 2
```

## API overview

Auth: `Authorization: Bearer <token>`. A super admin picks a brand with the `X-Tenant-Id` header.

**Admin**
```
POST   /api/auth/login
POST   /api/platform/tenants              (super admin) brand + first admin
GET    /api/platform/tenants | PATCH /api/platform/tenants/:id
GET    /api/admin/tenant | PATCH /api/admin/tenant           settings
GET    /api/admin/users | POST /api/admin/users
GET    /api/admin/products | POST | PATCH /:id
POST   /api/admin/qr-batches              { productId, quantity, label, mfgDate }
GET    /api/admin/qr-batches | GET /:id/export.csv | POST /:id/void
GET    /api/admin/qr/:code | GET /api/admin/qr/:code.png
GET    /api/admin/participants?type&status&q | POST | GET /:id | PATCH /:id
POST   /api/admin/participants/:id/adjust { points, note, idempotencyKey }
GET    /api/admin/redemptions?status | POST /:id/approve | POST /:id/reject
GET    /api/admin/fraud-flags | POST /:id/resolve
GET    /api/admin/dashboard?days=30
```

**Participant (mechanic app)**
```
GET    /api/p/:slug/info
POST   /api/p/:slug/auth/otp/request      { mobile }
POST   /api/p/:slug/auth/otp/verify       { mobile, otp, name?, type?, city? }
GET    /api/p/me | PATCH /api/p/me        { name, city, upiId, language }
POST   /api/p/scan                        { code | url, lat?, lng? }   header X-Device-Id
GET    /api/p/ledger?before=
POST   /api/p/redeem                      { points }
GET    /api/p/redemptions
```

**Public**
```
GET    /q/:code                            authenticity page (what a phone camera opens)
GET    /api/public/verify/:code
POST   /api/webhooks/payouts/:provider
```

## Brand settings (`tenants.settings`)

| Key | Default | Meaning |
|---|---|---|
| `pointValuePaise` | 100 | 1 point = ₹1 |
| `minRedeemPoints` | 100 | Minimum points per cash-out |
| `maxRedeemPointsPerDay` | 5000 | Cash-out cap per person per day |
| `autoApproveRedeemUptoPoints` | 0 | Payouts up to this many points are paid without approval (0 = off) |
| `dailyScanLimit` | 50 | Successful scans per person per day |
| `burstScanLimit` / `burstWindowSeconds` | 10 / 60 | Fast-scan limit |
| `invalidScanLimitPerHour` / `invalidScanBlockMinutes` | 5 / 60 | Scanning pauses after repeated invalid scans |
| `maxParticipantsPerDevice` | 3 | Shared-phone flag |
| `allowSelfSignup` / `selfSignupTypes` | true / trade types | Who can register themselves |

## Events outbox (Phase 2 hooks)

Rows in `events`: `participant.created`, `scan.succeeded`, `redemption.requested`, `redemption.paid`, `redemption.failed`, `fraud.flagged`, `points.adjusted`.

A worker will read rows where `delivered_at IS NULL` and send them on:
- **WhatsApp (Regulars):** "+20 points" receipts, payout confirmations, dormant nudges, OTP via an authentication template
- **WayneRing:** call lists for dormant mechanics and dealers
- **Royal:** dealer purchase points (Royal order `approved`/`delivered` webhook → `ledger.post`), and syncing participants/products via `external_ref`

## Before going live

1. Set `NODE_ENV=production`, a strong `JWT_SECRET` and `OTP_DEV_MODE=false`. The server refuses to start otherwise.
2. Wire the WhatsApp OTP sender (`src/services/otp.js` → `deliver`). Until then, production OTP does not reach users.
3. Fix `PUBLIC_BASE_URL` on your own domain **before printing any labels**. Every QR has this URL baked in.
4. Payouts: open a RazorpayX (or Cashfree Payouts) account, finish KYC, check the API fields in `payouts/razorpayx.js` against their current docs, and set up the webhook.
5. Ask a CA about tax/TDS on rewards paid to mechanics.
6. Daily Postgres backups. The ledger is money.

---

# Phase 2: Schemes, accounting connectors, WhatsApp bot

Run the worker next to the API: `npm run worker` (Docker: the `worker` service). It sends WhatsApp notifications from the outbox and auto-settles schemes.

Demo data: `npm run seed:demo && npm run seed:demo2` (dealers, Tally invoices, 3 live schemes, a mock WhatsApp number).
Tests: `npm run test:e2e2` (29 checks; server running with `WHATSAPP_SEND_MODE=mock`).

## Not locked to Tally: one canonical invoice format

Every source is converted into one document shape (`src/connectors/adapters.js`). Points and schemes never depend on which software the brand uses.

| Connector type | What it accepts |
|---|---|
| `TALLY` | Line-level JSON pushed by a Tally TDL (`vchguid, ledgerguid, itemsku, quantity, amount`, the same format Royal's Tally sync already uses) **or** a Tally XML voucher export |
| `ZOHO_BOOKS` | Invoice / credit-note webhook payloads |
| `BUSY`, `MARG`, `CSV` | Sales-register CSV from Busy, Marg, Vyapar, Excel or any other software. Common column names are auto-detected; set `config.columns` to map custom headers. Accepts dates like `01-11-2026`, `1-Nov-26`, `20261101` and amounts like `"10,000.00"` |
| `ROYAL` | Royal order webhook (`order.delivered` earns; `order.cancelled`/`returned` reverses). `config.earnOn`: `delivered` (default) or `approved` |
| `GENERIC` | Any software that can POST JSON (format shown in the console) |

Adding another system (SAP B1, Odoo, QuickBooks…) = one function mapping its payload to the canonical document.

**Endpoints** (header `X-Api-Key: lvx_…`, created in Console → Connectors; the key is shown once and stored only as a SHA-256 hash):
```
GET  /api/connect/ping
POST /api/connect/invoices     JSON | application/xml | text/csv   (up to 20 MB, 5,000 docs)
POST /api/connect/parties      dealer master upsert
POST /api/connect/royal        Royal order webhook
```

**Behaviour**
- Idempotent: the same voucher pushed again is a no-op (`connector + external id + doc type`).
- Dealer matching: external ref → GSTIN → mobile. An unmatched invoice waits in Console → Invoices. Map it once and the mapping is remembered, so that party's other pending invoices process too.
- Product matching: SKU → external ref → item name. Unknown items still count towards ₹ value schemes.
- Purchase points: `purchasePointsPer1000` (brand setting) on taxable value, or `products.purchase_points_per_unit`. Only for `purchaseEarnTypes` (dealer, distributor, retailer by default). `connector.config.earnPurchasePoints: false` records invoices for schemes only.
- Credit notes reverse points, capped at what the original invoice earned. A wallet can go negative after a return; future earnings net it off, and cash-out still needs a positive balance.
- ⚠️ Use **one** purchase source per brand (e.g. Royal **or** Tally, not both), otherwise the same sale is counted twice.

## Scheme engine

| Type | Measure | Paid |
|---|---|---|
| `PURCHASE_SLAB` | Net purchase ₹ (`AMOUNT`) or units (`QUANTITY`) in the period, after returns | At settlement |
| `SCAN_TARGET` | Number of scans in the period | At settlement |
| `SCAN_MULTIPLIER` | Each scan (2x, 3x…), optionally only on chosen products | Instantly |

Slab rewards: `FIXED_POINTS`, `PERCENT` (% of purchase value paid as points), `PER_UNIT`. The highest slab reached wins. AMOUNT slab minimums are in rupees.
Filters: participant types and products. Invoice dates count by IST calendar day.
Settlement: automatic once `ends_at + settle_grace_days` has passed (waits for late invoices), or "Settle now" in the console. Running it twice never pays twice. Live leaderboard shows "₹X more to the next slab".

```
GET  /api/admin/schemes | POST | PATCH /:id (draft only)
POST /api/admin/schemes/:id/activate | /cancel | /settle {force}
GET  /api/admin/schemes/:id/leaderboard
GET  /api/p/schemes                         participant's live progress
```

## WhatsApp bot

One webhook for all brands, routed by `phone_number_id`: `GET/POST /api/whatsapp/webhook` (verify token + `X-Hub-Signature-256` check when `WHATSAPP_APP_SECRET` is set). Access tokens are stored AES-256-GCM encrypted.

What dealers/mechanics can send (Roman Hinglish by default, `english` switches):
- `1` / `points` / `balance`: balance in points and ₹
- `2` / `scheme` / `offer`: every live scheme with progress and "₹X more to the next slab"
- `3` / `history`: last 5 transactions
- a product code `ABCD-EFGH-JKMN`: scan-to-earn straight from WhatsApp, with the same fraud rules as the app. Chit-chat is never treated as a code.
- an unknown number gets the join link

Notifications (worker): payout done/failed, scheme bonus, purchase recorded, welcome for dealers created by sync. Inside Meta's 24-hour window they go as free text. Outside it they need approved templates set in `tenant_channels.config.templates[eventType]` (body params listed in `src/services/notifications.js`). OTP needs an Authentication template (`otpTemplate`).

Console → WhatsApp has a **bot simulator**, so you can demo everything before Meta approves a number.

## Before going live (Phase 2)
1. Get each brand's WhatsApp number approved in Meta Business Manager. Create the templates (OTP, payout, scheme bonus, purchase receipt), set `WHATSAPP_SEND_MODE=live`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` and `ENCRYPTION_KEY`.
2. Check the adapters against **real exports** from each client's Tally/Busy/Marg/Zoho before trusting the points. Column names and Tally TDL fields vary by setup.
3. Decide each brand's single purchase source (Royal or accounting software).
