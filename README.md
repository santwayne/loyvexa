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
