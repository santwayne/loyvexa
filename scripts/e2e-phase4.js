// Phase 4 end-to-end (Bundle B): AI Channel Manager, Korvo outstanding feed,
// one-click Korvo link, sign-in from Korvo.
// Usage: BASE=http://localhost:4000 node scripts/e2e-phase4.js
//   Server running with WHATSAPP_SEND_MODE=mock CALL_PROVIDER=mock and
//   HUB_SECRET_KORVO=<32+ chars> KORVO_BASE_URL=http://127.0.0.1:4799 (this script starts a fake Korvo there)
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { pool, tx } from '../src/db/pool.js';
import * as ledger from '../src/services/ledger.js';
import { planTenant, composeBrief, sweepOutcomes, weeklyReportText, executeAction } from '../src/services/ai/index.js';
import { handleInbound } from '../src/services/bot.js';
import { pushPlaced } from '../src/services/orders.js';
import { decrypt } from '../src/lib/crypto.js';

const BASE = process.env.BASE || 'http://localhost:4000';
const HUB = process.env.HUB_SECRET_KORVO || '';
let passed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };
async function api(method, path, { token, key, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'X-Api-Key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let json; try { json = JSON.parse(t); } catch { json = t; }
  return { status: res.status, json };
}
const must = async (p, s = 200) => { const r = await p; assert.equal(r.status, s, JSON.stringify(r.json)); return r.json; };
const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
const run = Date.now().toString(36);
const uniq = String(Date.now()).slice(-5);
const mob = (n) => `9197${uniq}${String(n).padStart(3, '0')}`;
const DAY = 86400e3;
const now = new Date();
const dateAgo = (d) => new Date(now.getTime() - d * DAY).toISOString().slice(0, 10);

// ── fake Korvo (hub provision + external orders) ──
const korvo = { provisions: [], orders: [], key: `kvo_${crypto.randomBytes(8).toString('hex')}` };
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    const body = b ? JSON.parse(b) : {};
    const send = (s, j) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.url === '/api/v1/hub/provision') {
      try { jwt.verify((req.headers.authorization || '').slice(7), HUB, { issuer: 'loyvexa', audience: 'korvo' }); } catch (e) { return send(401, { message: e.message }); }
      korvo.provisions.push(body);
      return send(200, { success: true, companyId: 'c0ffee', companyName: 'Demo Auto Parts Pvt Ltd', korvoApiKey: korvo.key });
    }
    if (req.url === '/api/v1/orders/external') {
      if (req.headers['x-api-key'] !== korvo.key) return send(401, { message: 'bad key' });
      korvo.orders.push(body);
      return send(201, { success: true, orderNumber: 'DAP-ORD-20261108-0007' });
    }
    send(404, {});
  });
});
await new Promise((r) => fake.listen(4799, '127.0.0.1', r));

console.log('Loyvexa Phase 4 (AI Channel Manager + Korvo) — end-to-end');
const superToken = (await must(api('POST', '/api/auth/login', { body: { email: 'admin@wayneesolutions.com', password: 'ChangeMe@123' } }))).token;
const slug = `p4-${run}`;
await must(api('POST', '/api/platform/tenants', { token: superToken, body: {
  name: 'Gill Brakes', slug, admin: { name: 'Harpreet', email: `o@${slug}.in`, password: 'Passw0rd!' },
  settings: { aiEnabled: true, aiBriefNumbers: [mob(99)], aiContactFromHour: 0, aiContactToHour: 24, aiAutonomy: { MECHANIC_NUDGE: 'AUTO' }, orderDms: 'mock', callHoursStart: 0, callHoursEnd: 24 },
} }), 201);
const T = (await must(api('POST', '/api/auth/login', { body: { email: `o@${slug}.in`, password: 'Passw0rd!' } }))).token;
const [tenant] = await q(`SELECT * FROM tenants WHERE slug=$1`, [slug]);
ok('brand with the AI switched on (owner mobile for the plan)');

// products with dealer prices (orderable)
const [pA] = await q(`INSERT INTO products (tenant_id, sku, name, points, price_paise) VALUES ($1,'BRK-110','Brake Pad Set',20,45000) RETURNING *`, [tenant.id]);
const [pB] = await q(`INSERT INTO products (tenant_id, sku, name, points, price_paise) VALUES ($1,'CLT-220','Clutch Plate',30,120000) RETURNING *`, [tenant.id]);

const person = async (n, type, name, extra = {}) => (await q(
  `INSERT INTO participants (tenant_id, type, name, mobile, city, external_ref, segment, last_purchase_at, last_scan_at, upi_id, language) VALUES ($1,$2,$3,$4,'Ludhiana',$5,$6,$7,$8,$9,$10) RETURNING *`,
  [tenant.id, type, name, mob(n), extra.ref || null, extra.segment || 'REGULAR', extra.lastPurchase || null, extra.lastScan || null, extra.upi || null, extra.lang || 'hi']))[0];
const invoice = async (p, daysAgo, rupees, lines = [[pA, 10]]) => {
  const [i] = await q(`INSERT INTO invoices (tenant_id, source, external_id, doc_type, invoice_date, participant_id, total_paise, status, processed_at, created_at)
    VALUES ($1,'ROYAL',$2,'INVOICE',$3,$4,$5,'PROCESSED',now(),$6) RETURNING *`, [tenant.id, `INV-${crypto.randomBytes(4).toString('hex')}`, dateAgo(daysAgo), p.id, rupees * 100, new Date(now.getTime() - daysAgo * DAY)]);
  for (const [prod, qty] of lines) await q(`INSERT INTO invoice_lines (invoice_id, sku, item_name, product_id, qty, amount_paise) VALUES ($1,$2,$3,$4,$5,$6)`, [i.id, prod.sku, prod.name, prod.id, qty, Math.round((rupees * 100) / lines.length)]);
  return i;
};

// D1: orders every ~10 days, last order 11 days ago → reorder due
const D1 = await person(1, 'DEALER', 'Gill Auto Store', { ref: 'L-001', lastPurchase: new Date(now - 11 * DAY) });
for (const d of [51, 41, 31, 21, 11]) await invoice(D1, d, 22500, [[pA, 20], [pB, 5]]);
// D2: bought ₹60,000 then went quiet 40 days ago → AI call
const D2 = await person(2, 'DEALER', 'Sandhu Motors', { ref: 'L-002', segment: 'AT_RISK', lastPurchase: new Date(now - 40 * DAY) });
await invoice(D2, 40, 35000); await invoice(D2, 80, 25000);
// D3: overdue payment (from the Korvo feed below)
const D3 = await person(3, 'DEALER', 'Bajwa Spares', { ref: 'L-003' });
// D4: ₹40,000 bought in a scheme whose next slab is ₹50,000, ends in 5 days
const D4 = await person(4, 'DEALER', 'Mann Traders', { ref: 'L-004', lastPurchase: new Date(now - 3 * DAY) });
await invoice(D4, 3, 40000);
await q(`INSERT INTO schemes (tenant_id, name, type, metric, status, starts_at, ends_at, eligible_types, slabs) VALUES ($1,'Diwali Dhamaka','PURCHASE_SLAB','AMOUNT','ACTIVE',$2,$3,'{DEALER}',$4)`,
  [tenant.id, new Date(now - 20 * DAY), new Date(now.getTime() + 5 * DAY), JSON.stringify([{ min: 25000, rewardType: 'FIXED_POINTS', value: 200, label: 'Silver' }, { min: 50000, rewardType: 'FIXED_POINTS', value: 600, label: 'Gold' }])]);
// M1: mechanic who stopped scanning
const M1 = await person(5, 'MECHANIC', 'Raju Mechanic', { segment: 'AT_RISK', lastScan: new Date(now - 25 * DAY) });
await tx((db) => ledger.post(db, { tenantId: tenant.id, participantId: M1.id, type: 'EARN_SCAN', points: 600, refType: 'test', refId: `m1-${run}` }));
await q(`UPDATE ledger_entries SET created_at=$2 WHERE participant_id=$1`, [M1.id, new Date(now - 30 * DAY)]);
// M2: two fraud flags + a cash-out waiting
const M2 = await person(6, 'MECHANIC', 'Fake Kumar', { upi: 'fake@okaxis' });
await tx((db) => ledger.post(db, { tenantId: tenant.id, participantId: M2.id, type: 'EARN_SCAN', points: 900, refType: 'test', refId: `m2-${run}` }));
const red = await must(api('POST', `/api/p/redeem`, { token: jwt.sign({ kind: 'participant', sub: M2.id, tenantId: tenant.id }, process.env.JWT_SECRET || 'dev-only-change-me'), body: { points: 800 } }), 201).catch(async () => null);
if (!red) { // fall back to the service if the participant route shape differs
  const { requestRedemption } = await import('../src/services/redemption.js');
  await requestRedemption({ tenant, participantId: M2.id, points: 800 });
}
await q(`INSERT INTO fraud_flags (tenant_id, participant_id, rule) VALUES ($1,$2,'SHARED_DEVICE'),($1,$2,'BURST')`, [tenant.id, M2.id]);
ok('test network: 4 dealers, 2 mechanics, a live scheme, fraud flags');

// Korvo outstanding feed (connector key)
const conn = await must(api('POST', '/api/admin/connectors', { token: T, body: { type: 'ROYAL', name: 'Korvo DMS' } }), 201);
const key = conn.apiKey || conn.key || conn.plainKey;
assert.ok(key, JSON.stringify(conn));
const feed = await must(api('POST', '/api/connect/outstanding', { key, body: { asOf: now.toISOString(), complete: true, items: [
  { ref: 'L-003', name: 'Bajwa Spares', mobile: mob(3), outstanding: 30000, overdue: 18000, oldestDueDate: dateAgo(35), daysOverdue: 35 },
  { ref: 'L-001', name: 'Gill Auto Store', outstanding: 22500, overdue: 0, daysOverdue: 0 },
] } }));
assert.equal(feed.matched, 2);
ok('outstanding feed from Korvo matched to dealers by Korvo id');

// ── Plan ──
const planned = await planTenant(tenant, now);
const byType = Object.fromEntries(planned.map((a) => [a.type, a]));
for (const t of ['REORDER_NUDGE', 'WINBACK_CALL', 'SLAB_PUSH', 'MECHANIC_NUDGE', 'PAYMENT_REMINDER', 'FRAUD_REVIEW']) assert.ok(byType[t], `missing ${t}: ${planned.map((a) => a.type)}`);
assert.equal(byType.REORDER_NUDGE.participant_id, D1.id);
assert.match(byType.REORDER_NUDGE.reason, /every 10 days; last order 11 days ago/);
const bk = Object.fromEntries(byType.REORDER_NUDGE.payload.basket.map((b) => [b.sku, b.qty]));
assert.equal(bk['BRK-110'], 20); assert.equal(bk['CLT-220'], 5);
assert.equal(byType.WINBACK_CALL.participant_id, D2.id);
assert.equal(byType.SLAB_PUSH.participant_id, D4.id); assert.match(byType.SLAB_PUSH.payload.message, /₹10,000/);
assert.equal(byType.PAYMENT_REMINDER.participant_id, D3.id); assert.equal(Number(byType.PAYMENT_REMINDER.expected_paise), 1800000);
assert.equal(byType.FRAUD_REVIEW.participant_id, M2.id);
assert.equal(byType.MECHANIC_NUDGE.status, 'APPROVED', 'AUTO actions are pre-approved');
assert.equal(byType.FRAUD_REVIEW.autonomy, 'APPROVE');
ok('plan: reorder due, quiet dealer call, near-slab push, payment reminder, fraud hold, mechanic nudge');
assert.equal((await planTenant(tenant, now)).length, 0);
ok('planning again proposes nothing twice');

// ── Morning brief + owner approves on WhatsApp ──
const brief = await composeBrief(tenant, now);
assert.match(brief.text, /AI Channel Manager/); assert.match(brief.text, /Reply: \*1 3\*/);
assert.ok(brief.items.length >= 5);
ok('morning plan text is numbered with ₹ values');
const channel = { tenant };
const reorderItem = brief.items.find((a) => a.type === 'REORDER_NUDGE').brief_item;
const fraudItem = brief.items.find((a) => a.type === 'FRAUD_REVIEW').brief_item;
const r1 = await handleInbound({ channel, from: mob(99), text: `${reorderItem} ${fraudItem}` });
assert.match(r1, /ho gaya/);
let [a1] = await q(`SELECT * FROM ai_actions WHERE id=$1`, [byType.REORDER_NUDGE.id]);
assert.equal(a1.status, 'DONE'); assert.equal(a1.decided_by, `whatsapp:${mob(99)}`);
const [msg1] = await q(`SELECT * FROM messages WHERE participant_id=$1 AND direction='OUT' ORDER BY id DESC LIMIT 1`, [D1.id]);
assert.match(msg1.body, /REORDER/);
assert.equal((await q(`SELECT status FROM participants WHERE id=$1`, [M2.id]))[0].status, 'BLOCKED');
ok('owner replies "1 4" on WhatsApp → reminder sent to the dealer, fraudster blocked');
const r2 = await handleInbound({ channel, from: mob(99), text: 'ALL' });
assert.ok(r2.split('\n').length >= 3);
const [call] = await q(`SELECT k.*, c.script, c.source FROM calls k JOIN call_campaigns c ON c.id=k.campaign_id WHERE k.participant_id=$1`, [D2.id]);
assert.equal(call.script, 'DEALER_WINBACK'); assert.equal(call.source, 'ai'); assert.match(call.context.firstMessage, /order nahi aaya/);
ok('"ALL" → the AI call is queued with the dealer win-back script');
const auto = await executeAction(byType.MECHANIC_NUDGE.id, { now });
assert.ok(auto.action?.status === 'DONE' || auto.skipped);
assert.equal((await q(`SELECT status FROM ai_actions WHERE id=$1`, [byType.MECHANIC_NUDGE.id]))[0].status, 'DONE');
ok('AUTO action (mechanic nudge) ran without asking');
assert.equal((await handleInbound({ channel, from: mob(98), text: '1 2' })).includes('Rewards'), true);
ok('a stranger sending "1 2" gets the normal bot, not the AI');

// ── Dealer taps REORDER → cart from the suggested basket → order ──
const c1 = await handleInbound({ channel, from: D1.mobile, text: 'REORDER' });
assert.match(c1, /Brake Pad Set × 20/); assert.match(c1, /Clutch Plate × 5/);
const c2 = await handleInbound({ channel, from: D1.mobile, text: 'confirm' });
assert.match(c2, /Order \*WA-/);
const [ord] = await q(`SELECT * FROM orders WHERE participant_id=$1 AND status='PLACED'`, [D1.id]);
assert.equal(ord.ai_action_id, byType.REORDER_NUDGE.id); assert.equal(Number(ord.total_paise), 20 * 45000 + 5 * 120000);
ok('dealer replies REORDER → cart pre-filled with last order → confirm places it');

// ── Outcomes ──
await invoice(D2, 0, 30000); // quiet dealer buys again after the call
await must(api('POST', '/api/connect/outstanding', { key, body: { asOf: new Date(now.getTime() + 60000).toISOString(), complete: true, items: [{ ref: 'L-003', outstanding: 12000, overdue: 0, daysOverdue: 0 }] } }));
await q(`UPDATE ai_actions SET executed_at=now() - interval '1 minute' WHERE tenant_id=$1 AND status='DONE'`, [tenant.id]);
await q(`UPDATE invoices SET created_at=now() WHERE participant_id=$1 AND invoice_date=$2`, [D2.id, dateAgo(0)]);
await sweepOutcomes(new Date());
const won = Object.fromEntries((await q(`SELECT type, outcome, outcome_paise FROM ai_actions WHERE tenant_id=$1 AND outcome='WON'`, [tenant.id])).map((r) => [r.type, Number(r.outcome_paise)]));
assert.equal(won.REORDER_NUDGE, 1500000, 'WhatsApp order value');
assert.equal(won.WINBACK_CALL, 3000000, 'new invoice after the call');
assert.equal(won.PAYMENT_REMINDER, 1800000, 'overdue cleared');
ok('outcomes: reorder → ₹15,000 order, call → ₹30,000 invoice, reminder → ₹18,000 collected');
const rep = await weeklyReportText(tenant);
assert.match(rep.text, /₹63,000/); assert.match(rep.text, /payment recovery/);
ok('weekly report counts ₹63,000 influenced');

// ── Console API ──
const ov = await must(api('GET', '/api/admin/ai', { token: T }));
assert.equal(ov.week.won, 3); assert.equal(ov.korvo.overduePaise, 0);
assert.equal((await api('PATCH', '/api/admin/ai/settings', { token: T, body: { aiAutonomy: { FRAUD_REVIEW: 'AUTO' } } })).status, 400);
ok('console overview; fraud holds can never be set to run on their own');

// ── One-click Korvo link ──
assert.ok(HUB.length >= 32, 'set HUB_SECRET_KORVO for the server and this script');
const link = await must(api('POST', '/api/admin/korvo/link', { token: T, body: { companyCode: 'dap' } }));
assert.equal(link.companyCode, 'DAP');
const prov = korvo.provisions.at(-1);
assert.equal(prov.tenantSlug, slug); assert.match(prov.connectorKey, /^lvx_/);
const [t2] = await q(`SELECT * FROM tenants WHERE id=$1`, [tenant.id]);
assert.equal(decrypt(t2.korvo.apiKeyEnc), korvo.key); assert.equal(t2.settings.orderDms, 'korvo');
assert.equal((await api('GET', '/api/connect/ping', { key: prov.connectorKey })).status, 200);
assert.equal((await api('GET', '/api/connect/ping', { key })).status, 401, 'old key replaced');
ok('Connect Korvo: both sides keyed in one call; old connector key retired');
await q(`UPDATE orders SET dms='korvo' WHERE id=$1`, [ord.id]);
await pushPlaced();
assert.equal(korvo.orders.at(-1).externalOrderId, ord.order_no); assert.equal(korvo.orders.at(-1).items[0].quantity > 0, true);
assert.equal((await q(`SELECT dms_order_ref FROM orders WHERE id=$1`, [ord.id]))[0].dms_order_ref, 'DAP-ORD-20261108-0007');
ok('WhatsApp order pushed to Korvo with the brand\'s own key');

// ── Sign-in from the Korvo app ──
const sso = (claims) => jwt.sign({ purpose: 'sso', ...claims }, HUB, { algorithm: 'HS256', issuer: 'korvo', audience: 'loyvexa', subject: slug, expiresIn: 60, jwtid: crypto.randomBytes(8).toString('hex') });
const tk = sso({ email: `sales@${slug}.in`, name: 'Sales Head' });
const s1 = await must(api('POST', '/api/auth/hub-sso', { body: { token: tk } }));
assert.equal(s1.user.role, 'TENANT_ADMIN'); assert.equal(s1.user.tenantId, tenant.id);
assert.equal((await api('POST', '/api/auth/hub-sso', { body: { token: tk } })).status, 401);
assert.equal((await api('POST', '/api/auth/hub-sso', { body: { token: sso({ email: 'admin@wayneesolutions.com' }) } })).status, 403);
assert.equal((await must(api('GET', '/api/admin/ai', { token: s1.token }))).korvo.linked, true);
ok('Korvo admin opens the console in one click; links are single-use; never a super-admin session');

const bad = await q(`SELECT w.participant_id FROM wallets w LEFT JOIN (SELECT participant_id, sum(points) s FROM ledger_entries GROUP BY 1) l ON l.participant_id=w.participant_id WHERE w.balance <> coalesce(l.s,0)`);
assert.equal(bad.length, 0); ok('ledger integrity');

console.log(`\nAll ${passed} Phase 4 checks passed.`);
fake.close();
await pool.end();
process.exit(0);
