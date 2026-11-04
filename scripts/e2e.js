// End-to-end test of Phase 1 against a running server.
// Usage: BASE=http://localhost:4000 node scripts/e2e.js
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';

const BASE = process.env.BASE || 'http://localhost:4000';
const SUPER = { email: process.env.SUPER_ADMIN_EMAIL || 'admin@wayneesolutions.com', password: process.env.SUPER_ADMIN_PASSWORD || 'ChangeMe@123' };
let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

async function api(method, path, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (raw) return { status: res.status, text };
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
const must = async (p, status = 200) => { const r = await p; assert.equal(r.status, status, JSON.stringify(r.json)); return r.json; };

const run = Date.now().toString(36);
const mob = (n) => `9${String(Date.now()).slice(-7)}${String(n).padStart(2, '0')}`;

async function login(email, password) { return (await must(api('POST', '/api/auth/login', { body: { email, password } }))).token; }

async function participantLogin(slug, mobile, extra = {}) {
  const o = await must(api('POST', `/api/p/${slug}/auth/otp/request`, { body: { mobile } }));
  assert.ok(o.devOtp);
  const bad = await api('POST', `/api/p/${slug}/auth/otp/verify`, { body: { mobile, otp: '000000' === o.devOtp ? '111111' : '000000' } });
  assert.equal(bad.status, 400);
  const v = await api('POST', `/api/p/${slug}/auth/otp/verify`, { body: { mobile, otp: o.devOtp, ...extra } });
  assert.ok([200, 201].includes(v.status), JSON.stringify(v.json));
  return v.json.token;
}

async function makeBrand(superToken, slug, settings = {}) {
  const email = `admin@${slug}.test`;
  await must(api('POST', '/api/platform/tenants', { token: superToken, body: { name: `Brand ${slug}`, slug, settings, admin: { name: 'Owner', email, password: 'Passw0rd!' } } }), 201);
  return login(email, 'Passw0rd!');
}

async function batchCodes(token, productId, quantity) {
  const { batch } = await must(api('POST', '/api/admin/qr-batches', { token, body: { productId, quantity, label: 'test', mfgDate: '2026-11-01' } }), 201);
  const csv = await api('GET', `/api/admin/qr-batches/${batch.id}/export.csv`, { token, raw: true });
  assert.equal(csv.status, 200);
  const lines = csv.text.trim().split('\n').slice(1);
  assert.equal(lines.length, quantity);
  return { batch, codes: lines.map((l) => l.split(',')[1].replace(/"/g, '')), urls: lines.map((l) => l.split(',')[3].replace(/"/g, '')) };
}

console.log('Loyvexa Phase 1 — end-to-end');
const superToken = await login(SUPER.email, SUPER.password); ok('super admin login');

const slugA = `brand-a-${run}`, slugB = `brand-b-${run}`;
const A = await makeBrand(superToken, slugA, { burstScanLimit: 100, dailyScanLimit: 200, minRedeemPoints: 50 });
const B = await makeBrand(superToken, slugB);
ok('two brands onboarded with admins');

const { product } = await must(api('POST', '/api/admin/products', { token: A, body: { sku: 'BP-01', name: 'Brake Pad', points: 20, pointsByType: { RETAILER: 5 } } }), 201);
const dup = await api('POST', '/api/admin/products', { token: A, body: { sku: 'BP-01', name: 'x', points: 1 } });
assert.equal(dup.status, 409); ok('product created; duplicate SKU rejected');

const t0 = Date.now();
const big = await batchCodes(A, product.id, 2000);
assert.equal(new Set(big.codes).size, 2000); ok(`2000 unique QR codes generated + CSV export (${Date.now() - t0} ms)`);

// Public authenticity
let v = await must(api('GET', `/api/public/verify/${big.codes[0]}`));
assert.equal(v.result, 'GENUINE'); assert.equal(v.product.sku, 'BP-01');
const fake = await must(api('GET', '/api/public/verify/ZZZZZZZZZZZZ'));
assert.equal(fake.result, 'NOT_FOUND');
const page = await api('GET', new URL(big.urls[1]).pathname, { raw: true });
assert.equal(page.status, 200); assert.match(page.text, /Genuine product/);
ok('counterfeit check: genuine / not-found / landing page');

// Participants
const m1 = await participantLogin(slugA, mob(1), { name: 'Raju Mechanic', type: 'MECHANIC', city: 'Ludhiana' });
const m2 = await participantLogin(slugA, mob(2), { name: 'Sonu', type: 'MECHANIC', city: 'Jalandhar' });
const r1 = await participantLogin(slugA, mob(3), { name: 'Shop', type: 'RETAILER', city: 'Ludhiana' });
ok('OTP login + self signup (wrong OTP rejected)');

let s = await must(api('POST', '/api/p/scan', { token: m1, body: { code: big.urls[0], lat: 30.9, lng: 75.85 } }));
assert.equal(s.points, 20); assert.equal(s.wallet.balance, 20);
s = await must(api('POST', '/api/p/scan', { token: r1, body: { code: big.codes[1].toLowerCase().match(/.{1,4}/g).join('-') } }));
assert.equal(s.points, 5); ok('scan-to-earn via URL and printed code; per-type points (mechanic 20, retailer 5)');

let again = await api('POST', '/api/p/scan', { token: m1, body: { code: big.codes[0] } });
assert.equal(again.status, 422); assert.equal(again.json.result, 'ALREADY_SCANNED');
again = await api('POST', '/api/p/scan', { token: m2, body: { code: big.codes[0] } });
assert.equal(again.json.result, 'ALREADY_SCANNED');
ok('code pays only once');

v = await must(api('GET', `/api/public/verify/${big.codes[0]}`));
assert.equal(v.result, 'ALREADY_SCANNED'); assert.equal(v.genuine, true); ok('verify shows reward already claimed');

// Race: 30 concurrent scans of the same code from 3 people
const raceCode = big.codes[10];
const racers = [await participantLogin(slugA, mob(6), { name: 'R1' }), await participantLogin(slugA, mob(7), { name: 'R2' }), await participantLogin(slugA, mob(8), { name: 'R3' })];
const results = await Promise.all(Array.from({ length: 30 }, (_, i) => api('POST', '/api/p/scan', { token: racers[i % 3], body: { code: raceCode } })));
assert.equal(results.filter((x) => x.status === 200).length, 1); ok('30 concurrent scans of one code → exactly 1 payout');
const selfAgain = await Promise.all([1, 2, 3, 4, 5, 6].map(() => api('POST', '/api/p/scan', { token: m1, body: { code: big.codes[0] } })));
assert.ok(selfAgain.every((x) => x.json.result === 'ALREADY_SCANNED'));
await must(api('POST', '/api/p/scan', { token: m1, body: { code: big.codes[19] } })); ok('re-scanning own code 6× does not lock the mechanic out');

// Earn more for m1
for (let i = 20; i < 30; i++) await must(api('POST', '/api/p/scan', { token: m1, body: { code: big.codes[i] } }));
let me1 = await must(api('GET', '/api/p/me', { token: m1 }));
const m1Expected = 20 + 200 + (results.find((x) => x.status === 200 && x.json.points === 20) ? 0 : 0);
assert.ok(me1.wallet.balance >= 220); ok(`m1 balance ${me1.wallet.balance}`);

// Wrong brand
const { product: pB } = await must(api('POST', '/api/admin/products', { token: B, body: { sku: 'X1', name: 'Other', points: 10 } }), 201);
const bCodes = await batchCodes(B, pB.id, 3);
const wb = await api('POST', '/api/p/scan', { token: m2, body: { code: bCodes.codes[0] } });
assert.equal(wb.json.result, 'WRONG_BRAND'); ok('other brand\'s code rejected');

// Tenant isolation
const pid = (await must(api('GET', '/api/admin/participants', { token: A }))).participants[0].id;
const iso = await api('GET', `/api/admin/participants/${pid}`, { token: B });
assert.equal(iso.status, 404); ok('brand B cannot see brand A participants');

// Void batch
const small = await batchCodes(A, product.id, 5);
await must(api('POST', `/api/admin/qr-batches/${small.batch.id}/void`, { token: A }));
const vs = await api('POST', '/api/p/scan', { token: m1, body: { code: small.codes[0] } });
assert.equal(vs.json.result, 'VOID');
assert.equal((await must(api('GET', `/api/public/verify/${small.codes[1]}`))).result, 'VOID'); ok('voided batch cannot be scanned');

// Invalid scan lockout (m2: already 2 invalid-type attempts + WRONG_BRAND)
const m3 = await participantLogin(slugA, mob(4), { name: 'Guesser', type: 'MECHANIC' });
for (let i = 0; i < 5; i++) await api('POST', '/api/p/scan', { token: m3, body: { code: `ABCDEFGH${i}JKM` } });
const locked = await api('POST', '/api/p/scan', { token: m3, body: { code: big.codes[50] } });
assert.equal(locked.json.result, 'BLOCKED'); ok('5 invalid scans → scanning paused');
const flags = await must(api('GET', '/api/admin/fraud-flags', { token: A }));
const rules = new Set(flags.flags.map((f) => f.rule));
assert.ok(rules.has('REPEATED_INVALID_SCANS') && rules.has('SCANNED_SOMEONE_ELSES_CODE')); ok(`fraud flags raised: ${[...rules].join(', ')}`);
const m3id = flags.flags.find((f) => f.rule === 'REPEATED_INVALID_SCANS').participant_id;
await must(api('PATCH', `/api/admin/participants/${m3id}`, { token: A, body: { clearScanBlock: true } }));
await must(api('POST', '/api/p/scan', { token: m3, body: { code: big.codes[50] } })); ok('admin can lift scan pause');

// Burst limit on a strict brand
const C = await makeBrand(superToken, `brand-c-${run}`, { burstScanLimit: 3 });
const { product: pC } = await must(api('POST', '/api/admin/products', { token: C, body: { sku: 'C1', name: 'C', points: 1 } }), 201);
const cCodes = await batchCodes(C, pC.id, 5);
const mc = await participantLogin(`brand-c-${run}`, mob(5), { name: 'Fast' });
for (let i = 0; i < 3; i++) await must(api('POST', '/api/p/scan', { token: mc, body: { code: cCodes.codes[i] } }));
const burst = await api('POST', '/api/p/scan', { token: mc, body: { code: cCodes.codes[3] } });
assert.equal(burst.json.result, 'LIMIT'); ok('burst scanning limited');

// Redemptions
let red = await api('POST', '/api/p/redeem', { token: m1, body: { points: 60 } });
assert.equal(red.status, 400); assert.equal(red.json.error.code, 'UPI_REQUIRED');
const badUpi = await api('PATCH', '/api/p/me', { token: m1, body: { upiId: 'not-a-upi' } });
assert.equal(badUpi.status, 400);
await must(api('PATCH', '/api/p/me', { token: m1, body: { upiId: 'raju@okaxis' } }));
red = await api('POST', '/api/p/redeem', { token: m1, body: { points: 10 } });
assert.equal(red.json.error.code, 'BELOW_MINIMUM');
red = await api('POST', '/api/p/redeem', { token: m1, body: { points: 999999 } });
assert.equal(red.json.error.code === 'INSUFFICIENT_POINTS' || red.json.error.code === 'DAILY_REDEEM_LIMIT', true);
ok('redeem guards: UPI required, valid UPI, minimum, balance');

const before = (await must(api('GET', '/api/p/me', { token: m1 }))).wallet;
const { redemption } = await must(api('POST', '/api/p/redeem', { token: m1, body: { points: 100 } }), 201);
assert.equal(redemption.status, 'REQUESTED'); assert.equal(redemption.amount_paise, 10000);
let w = (await must(api('GET', '/api/p/me', { token: m1 }))).wallet;
assert.equal(w.balance, before.balance - 100); assert.equal(w.held, 100); ok('redeem request holds points (₹100)');

const [ap1, ap2] = await Promise.all([
  api('POST', `/api/admin/redemptions/${redemption.id}/approve`, { token: A }),
  api('POST', `/api/admin/redemptions/${redemption.id}/approve`, { token: A }),
]);
assert.deepEqual([ap1.status, ap2.status].sort(), [200, 409]);
w = (await must(api('GET', '/api/p/me', { token: m1 }))).wallet;
assert.equal(w.held, 0); assert.equal(w.lifetime_redeemed, 100); ok('double-click approve pays once → PAID, hold settled');

// Failure + refund path
await must(api('PATCH', '/api/p/me', { token: m1, body: { upiId: 'willfail@upi' } }));
const { redemption: rf } = await must(api('POST', '/api/p/redeem', { token: m1, body: { points: 50 } }), 201);
const fr = await must(api('POST', `/api/admin/redemptions/${rf.id}/approve`, { token: A }));
assert.equal(fr.redemption.status, 'FAILED');
const w2 = (await must(api('GET', '/api/p/me', { token: m1 }))).wallet;
assert.equal(w2.balance, w.balance); assert.equal(w2.held, 0); ok('failed payout auto-refunds points');

// Reject path
await must(api('PATCH', '/api/p/me', { token: m1, body: { upiId: 'raju@okaxis' } }));
const { redemption: rr } = await must(api('POST', '/api/p/redeem', { token: m1, body: { points: 50 } }), 201);
await must(api('POST', `/api/admin/redemptions/${rr.id}/reject`, { token: A, body: { reason: 'KYC pending' } }));
const w3 = (await must(api('GET', '/api/p/me', { token: m1 }))).wallet;
assert.equal(w3.balance, w.balance); ok('admin reject refunds points');

// Manual adjust idempotency
const adjBody = { points: 25, note: 'Diwali bonus', idempotencyKey: `diwali-${run}` };
await must(api('POST', `/api/admin/participants/${m3id}/adjust`, { token: A, body: adjBody }));
const dupAdj = await api('POST', `/api/admin/participants/${m3id}/adjust`, { token: A, body: adjBody });
assert.equal(dupAdj.status, 409); ok('manual adjustment is idempotent');

// Dashboard
const d = await must(api('GET', '/api/admin/dashboard', { token: A }));
assert.ok(d.kpis.codes_generated >= 2005 && d.kpis.codes_scanned > 0 && d.kpis.paid_paise === 10000);
assert.equal(d.daily.length, 30); ok(`dashboard: ${d.kpis.participants} participants, ${d.kpis.codes_scanned} scans, liability ${d.kpis.points_liability} pts, paid ₹${d.kpis.paid_paise / 100}`);

// Ledger integrity across the whole DB
const { rows: bad } = await pool.query(`
  SELECT w.participant_id FROM wallets w
   LEFT JOIN (SELECT participant_id, sum(points) s FROM ledger_entries GROUP BY 1) l ON l.participant_id=w.participant_id
   LEFT JOIN (SELECT participant_id, sum(points) s FROM redemptions WHERE status IN ('REQUESTED','PROCESSING') GROUP BY 1) h ON h.participant_id=w.participant_id
   LEFT JOIN (SELECT participant_id, sum(points) s FROM redemptions WHERE status='PAID' GROUP BY 1) pd ON pd.participant_id=w.participant_id
  WHERE w.balance <> coalesce(l.s,0) OR w.held <> coalesce(h.s,0) OR w.lifetime_redeemed <> coalesce(pd.s,0)`);
assert.equal(bad.length, 0, `wallet mismatch: ${JSON.stringify(bad)}`);
const { rows: [sc] } = await pool.query(`SELECT count(*) n FROM qr_codes q WHERE status='SCANNED' AND (SELECT count(*) FROM ledger_entries l WHERE l.ref_type='qr_code' AND l.ref_id=q.id::text) <> 1`);
assert.equal(Number(sc.n), 0); ok('ledger integrity: every wallet = sum of ledger; every scanned code paid exactly once');

const { rows: ev } = await pool.query(`SELECT type, count(*) n FROM events GROUP BY 1 ORDER BY 1`);
ok(`outbox events ready for Phase 2: ${ev.map((e) => `${e.type}=${e.n}`).join(', ')}`);

console.log(`\nAll ${passed} checks passed.`);
await pool.end();
