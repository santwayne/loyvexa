// Phase 3 end-to-end: segmentation, AI call campaigns, WhatsApp ordering → DMS → points, Korvo token exchange,
// WhatsApp campaigns + opt-out + receipts, points expiry, tenant isolation.
// Usage: BASE=http://localhost:4000 node scripts/e2e-phase3.js   (server running, WHATSAPP_SEND_MODE=mock, CALL_PROVIDER=mock)
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';
import { tick } from '../src/worker.js';

const BASE = process.env.BASE || 'http://localhost:4000';
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
const mob = (n) => `96${uniq}${String(n).padStart(3, '0')}`;  // 10 digits, last digit = n % 10
const DAY = 86400e3;
const iso = (ms) => new Date(ms).toISOString();
const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

console.log('Loyvexa Phase 3 — end-to-end');
const superToken = (await must(api('POST', '/api/auth/login', { body: { email: 'admin@wayneesolutions.com', password: 'ChangeMe@123' } }))).token;
const mkBrand = async (slug, settings) => {
  await must(api('POST', '/api/platform/tenants', { token: superToken, body: { name: `Brand ${slug}`, slug, settings, admin: { name: 'Owner', email: `o@${slug}.in`, password: 'Passw0rd!' } } }), 201);
  return (await must(api('POST', '/api/auth/login', { body: { email: `o@${slug}.in`, password: 'Passw0rd!' } }))).token;
};
const slug = `p3-${run}`;
const A = await mkBrand(slug, { callHoursStart: 0, callHoursEnd: 24, orderDms: 'mock', pointsExpiryMonths: 6, burstScanLimit: 100 });
const B = await mkBrand(`p3b-${run}`, {});
ok('two brands (A: 24h calling, mock DMS, 6-month expiry)');

const signup = async (n, type, name) => {
  const o = await must(api('POST', `/api/p/${slug}/auth/otp/request`, { body: { mobile: mob(n) } }));
  const v = await api('POST', `/api/p/${slug}/auth/otp/verify`, { body: { mobile: mob(n), otp: o.devOtp, name, type, city: 'Ludhiana' } });
  assert.ok([200, 201].includes(v.status));
  return { token: v.json.token, id: (await q(`SELECT id FROM participants WHERE mobile=$1 AND tenant_id=(SELECT id FROM tenants WHERE slug=$2)`, [`91${mob(n)}`, slug]))[0].id, phone: `91${mob(n)}` };
};
const { product: brk } = await must(api('POST', '/api/admin/products', { token: A, body: { sku: 'BRK-9', name: 'Brake Pad', points: 20, pricePaise: 45000 } }), 201);
const { batch } = await must(api('POST', '/api/admin/qr-batches', { token: A, body: { productId: brk.id, quantity: 20 } }), 201);
const codes = (await q(`SELECT code FROM qr_codes WHERE batch_id=$1 ORDER BY serial_no`, [batch.id])).map((r) => r.code);
let ci = 0;
const scan = (t) => must(api('POST', '/api/p/scan', { token: t, body: { code: codes[ci++] } }));

// ---------- 1. Segmentation ----------
const m0 = await signup(10, 'MECHANIC', 'Mech Zero');      // last digit 0 → INTERESTED
await scan(m0.token);
const seg = async (offsetDays) => must(api('POST', '/api/admin/segments/recompute', { token: A, body: { asOf: iso(Date.now() + offsetDays * DAY) } }));
const segOf = async (id) => (await q(`SELECT segment FROM participants WHERE id=$1`, [id]))[0].segment;
await seg(0); assert.equal(await segOf(m0.id), 'NEW');
await seg(15); assert.equal(await segOf(m0.id), 'REGULAR');
await seg(25); assert.equal(await segOf(m0.id), 'AT_RISK');
await seg(50); assert.equal(await segOf(m0.id), 'DORMANT');
const hist = await q(`SELECT segment FROM participant_segments WHERE participant_id=$1 ORDER BY id`, [m0.id]);
assert.deepEqual(hist.map((h) => h.segment), ['NEW', 'REGULAR', 'AT_RISK', 'DORMANT']);
const segEvents = await q(`SELECT count(*)::int n FROM events WHERE type='segment.changed' AND payload->>'participantId'=$1`, [m0.id]);
assert.equal(segEvents[0].n, 4);
ok('mechanic moves NEW → REGULAR → AT_RISK → DORMANT over simulated days; 4 history rows, 4 events');

// dealer with big purchases → HIGH_SPENDER
const korvo = await must(api('POST', '/api/admin/connectors', { token: A, body: { type: 'ROYAL', name: 'Korvo DMS', config: { earnOn: 'delivered', allowTokenExchange: true } } }), 201);
await must(api('POST', '/api/connect/parties', { key: korvo.apiKey, body: [{ _id: 'KD-1', name: 'Gill Auto', mobile: mob(21), role: 'dealers' }, { _id: 'KD-2', name: 'Sharma Spares', mobile: mob(22), role: 'dealers' }] }));
const order1 = { orderNumber: `RO-${run}-1`, orderDate: `${today}T05:00:00Z`, dealerId: 'KD-1', items: [{ productCode: 'BRK-9', quantity: 500, taxableValue: 250000 }] };
await must(api('POST', '/api/connect/royal', { key: korvo.apiKey, body: { event: 'order.delivered', order: { ...order1, status: 'delivered' } } }));
const gillId = (await q(`SELECT id FROM participants WHERE external_ref='KD-1' AND tenant_id=(SELECT id FROM tenants WHERE slug=$1)`, [slug]))[0].id;
await seg(15);
assert.equal(await segOf(gillId), 'HIGH_SPENDER');
ok('dealer who bought ₹2.5 lakh (2,500 pts in 90 days) → HIGH_SPENDER');

const sA = await must(api('GET', '/api/admin/segments', { token: A }));
const sB = await must(api('GET', '/api/admin/segments', { token: B }));
assert.ok(sA.bySegment.HIGH_SPENDER >= 1); assert.equal(Object.keys(sB.bySegment).length, 0);
ok('segment counts are per brand');

// ---------- 2. AI call campaigns ----------
const m4 = await signup(14, 'MECHANIC', 'Mech Four');      // → NOT_INTERESTED
const m9 = await signup(19, 'MECHANIC', 'Mech Nine');      // → WRONG_NUMBER
const mD = await signup(13, 'MECHANIC', 'Mech DND');
for (const m of [m4, m9, mD]) await scan(m.token);
await must(api('POST', `/api/admin/participants/${mD.id}/flags`, { token: A, body: { dnd: true } }));
await seg(50); // everyone idle 50 days → DORMANT
const walletsBefore = await q(`SELECT sum(balance)::int s FROM wallets WHERE tenant_id=(SELECT id FROM tenants WHERE slug=$1)`, [slug]);
const { campaign: cc } = await must(api('POST', '/api/admin/call-campaigns', { token: A, body: { name: 'Win back dormant mechanics', script: 'WINBACK', language: 'hi', segments: ['DORMANT'], participantTypes: ['MECHANIC'] } }), 201);
const launched = await must(api('POST', `/api/admin/call-campaigns/${cc.id}/launch`, { token: A }));
assert.equal(launched.queued, 3); assert.equal(launched.skipped.dnd, 1);
const callRows = await must(api('GET', `/api/admin/call-campaigns/${cc.id}/calls`, { token: A }));
assert.match(callRows.calls[0].first_message, /Namaste .* ji, main Brand p3/);
ok('call campaign: 3 dormant mechanics queued, DND skipped; Hindi script personalised');

await must(api('POST', '/api/admin/call-campaigns/dispatch', { token: A }));
const list = await must(api('GET', '/api/admin/call-campaigns', { token: A }));
const st = list.campaigns.find((c) => c.id === cc.id);
assert.equal(st.status, 'COMPLETED'); assert.equal(st.stats.completed, 3);
assert.deepEqual(st.stats.outcomes, { INTERESTED: 1, NOT_INTERESTED: 1, WRONG_NUMBER: 1 });
const walletsAfter = await q(`SELECT sum(balance)::int s FROM wallets WHERE tenant_id=(SELECT id FROM tenants WHERE slug=$1)`, [slug]);
assert.equal(walletsAfter[0].s, walletsBefore[0].s);
ok('dialled via provider: outcomes recorded, campaign completed, points untouched');

const { campaign: cc2 } = await must(api('POST', '/api/admin/call-campaigns', { token: A, body: { name: 'Again', script: 'SCHEME_REMINDER', segments: ['DORMANT'], participantTypes: ['MECHANIC'] } }), 201);
const l2 = await must(api('POST', `/api/admin/call-campaigns/${cc2.id}/launch`, { token: A }));
assert.equal(l2.queued, 0); assert.equal(l2.skipped.cooldown, 3);
ok('7-day cooldown: nobody is called twice in a week');

const firstCall = (await q(`SELECT id, outcome FROM calls WHERE campaign_id=$1 ORDER BY created_at LIMIT 1`, [cc.id]))[0];
await must(api('POST', '/api/webhooks/calls/mock', { body: { callId: firstCall.id, outcome: 'NOT_INTERESTED' } }));
assert.equal((await q(`SELECT outcome FROM calls WHERE id=$1`, [firstCall.id]))[0].outcome, firstCall.outcome);
// a call still ringing gets DO_NOT_CALL from the provider webhook
const m8 = await signup(18, 'MECHANIC', 'Mech Eight');
await seg(0);
const { campaign: cc3 } = await must(api('POST', '/api/admin/call-campaigns', { token: A, body: { name: 'Feedback', script: 'FEEDBACK', segments: ['NEW'] } }), 201);
await must(api('POST', `/api/admin/call-campaigns/${cc3.id}/launch`, { token: A }));
const pend = (await q(`SELECT id FROM calls WHERE campaign_id=$1 AND participant_id=$2`, [cc3.id, m8.id]))[0];
await q(`UPDATE calls SET status='DIALING', provider_call_id=$2 WHERE id=$1`, [pend.id, `PROV-${run}`]);
await must(api('POST', '/api/webhooks/calls/mock', { body: { providerCallId: `PROV-${run}`, outcome: 'DO_NOT_CALL', summary: 'Asked not to be called' } }));
assert.equal((await q(`SELECT dnd FROM participants WHERE id=$1`, [m8.id]))[0].dnd, true);
ok('webhook is idempotent; DO_NOT_CALL outcome sets the DND flag');

// ---------- 3. WhatsApp ordering → DMS → points ----------
const pr = await must(api('POST', '/api/connect/products', { key: korvo.apiKey, body: [{ productCode: 'CLT-9', productName: 'Clutch Plate', price: 820, mrp: 1100, category: 'Clutch' }, { sku: 'BRK-9', name: 'Brake Pad', price: 450 }] }));
assert.equal(pr.created, 1); assert.equal(pr.updated, 1);
ok('product master sync from Korvo (create + update prices)');

const phoneNumberId = `PN3-${run}`;
await must(api('PUT', '/api/admin/channels/whatsapp', { token: A, body: { phoneNumberId } }));
let wid = 0;
const wa = async (from, text) => {
  await must(api('POST', '/api/whatsapp/webhook', { body: { entry: [{ changes: [{ value: { metadata: { phone_number_id: phoneNumberId }, messages: [{ from, id: `w3-${run}-${wid++}`, type: 'text', text: { body: text } }] } }] }] } }));
  return (await q(`SELECT body FROM messages WHERE peer=$1 AND direction='OUT' ORDER BY id DESC LIMIT 1`, [from]))[0]?.body;
};
const gill = `91${mob(21)}`;
let msg = await wa(gill, 'menu');
assert.match(msg, /4️⃣ Order karo/);
msg = await wa(gill, 'order');
assert.match(msg, /1\. Brake Pad \(BRK-9\) — ₹450/); assert.match(msg, /2\. Clutch Plate \(CLT-9\) — ₹820/);
msg = await wa(gill, '1 10'); assert.match(msg, /Brake Pad × 10/);
msg = await wa(gill, '2 x 5'); assert.match(msg, /Total: ₹8,600/);
msg = await wa(gill, '1 0'); assert.match(msg, /hata diya/); assert.match(msg, /Total: ₹4,100/);
msg = await wa(gill, '1 12'); assert.match(msg, /Total: ₹9,500/);
msg = await wa(gill, '9 1'); assert.match(msg, /list mein nahi/);
msg = await wa(gill, 'confirm'); assert.match(msg, /Order \*WA-\d{6}-[0-9A-F]{4}\* mil gaya \(₹9,500\)/);
ok('dealer orders on WhatsApp: catalog, add, change qty, remove, total ₹9,500, confirm');

msg = await wa(gill, '1'); assert.match(msg, /points/);
msg = await wa(`91${mob(14)}`, 'order'); assert.match(msg, /sirf dealers/);
ok('after confirm "1" is balance again; mechanics cannot order');

const ord = (await q(`SELECT * FROM orders WHERE participant_id=$1 AND status <> 'CART'`, [gillId]))[0];
assert.equal(ord.status, 'PLACED');
await tick();
const sent = (await q(`SELECT * FROM orders WHERE id=$1`, [ord.id]))[0];
assert.equal(sent.status, 'SENT_TO_DMS'); assert.equal(sent.dms_order_ref, `KRV-${ord.order_no}`);
const note = (await q(`SELECT body FROM messages WHERE peer=$1 AND direction='OUT' ORDER BY id DESC LIMIT 1`, [gill]))[0].body;
assert.match(note, new RegExp(`Order \\*${ord.order_no}\\* brand ko mil gaya \\(ref KRV-`));
ok('worker pushed order to DMS (mock Korvo), dealer got the confirmation on WhatsApp');

const balBefore = (await q(`SELECT balance FROM wallets WHERE participant_id=$1`, [gillId]))[0].balance;
const delivered = { event: 'order.delivered', order: { orderNumber: sent.dms_order_ref, status: 'delivered', orderDate: `${today}T06:00:00Z`, dealerId: 'KD-1', items: [{ productCode: 'BRK-9', quantity: 12, taxableValue: 5400 }, { productCode: 'CLT-9', quantity: 5, taxableValue: 4100 }] } };
const d1 = await must(api('POST', '/api/connect/royal', { key: korvo.apiKey, body: delivered }));
const d2 = await must(api('POST', '/api/connect/royal', { key: korvo.apiKey, body: delivered }));
assert.equal(d1.pointsAwarded, 95); assert.equal(d2.duplicates, 1);
assert.equal((await q(`SELECT balance FROM wallets WHERE participant_id=$1`, [gillId]))[0].balance, balBefore + 95);
ok('Korvo delivers the WhatsApp order → +95 purchase points, exactly once');

// ---------- 4. Korvo Rewards tab: token exchange ----------
const tk = await must(api('POST', '/api/connect/participant-token', { key: korvo.apiKey, body: { externalRef: 'KD-1' } }));
const me = await must(api('GET', '/api/p/me', { token: tk.token }));
assert.equal(me.participant.name, 'Gill Auto'); assert.equal(me.wallet.balance, balBefore + 95);
const tally = await must(api('POST', '/api/admin/connectors', { token: A, body: { type: 'TALLY', name: 'Tally' } }), 201);
assert.equal((await api('POST', '/api/connect/participant-token', { key: tally.apiKey, body: { externalRef: 'KD-1' } })).status, 403);
ok('Korvo backend swaps dealer ref for a 1-hour token and reads the Rewards data; other connectors refused');

// ---------- 5. WhatsApp campaigns ----------
const sharma = `91${mob(22)}`;
msg = await wa(sharma, 'STOP'); assert.match(msg, /campaign messages nahi aayenge/);
const { campaign: wc } = await must(api('POST', '/api/admin/wa-campaigns', { token: A, body: { name: 'Diwali push', templateName: 'scheme_push_v1', language: 'hi', params: ['{name}', '{balance}'], previewText: 'Namaste {name}, aapke {balance} points hain', participantTypes: ['DEALER'] } }), 201);
const wl = await must(api('POST', `/api/admin/wa-campaigns/${wc.id}/launch`, { token: A }));
assert.equal(wl.queued, 1); assert.equal(wl.skipped.optedOut, 1);
await must(api('POST', '/api/admin/wa-campaigns/run', { token: A }));
const rec = (await q(`SELECT r.status, m.body, m.id AS mid FROM wa_campaign_recipients r JOIN messages m ON m.id=r.message_id WHERE r.campaign_id=$1`, [wc.id]))[0];
assert.equal(rec.status, 'SENT'); assert.match(rec.body, /Namaste Gill Auto, aapke [\d,]+ points hain/);
ok('campaign skips the dealer who sent STOP; personalised template sent to the rest');

await q(`UPDATE messages SET provider_msg_id=$2 WHERE id=$1`, [rec.mid, `wamid.${run}`]);
const status = (s) => api('POST', '/api/whatsapp/webhook', { body: { entry: [{ changes: [{ value: { metadata: { phone_number_id: phoneNumberId }, statuses: [{ id: `wamid.${run}`, status: s }] } }] }] } });
await must(status('delivered')); await must(status('read')); await must(status('delivered'));
assert.equal((await q(`SELECT status FROM wa_campaign_recipients WHERE campaign_id=$1`, [wc.id]))[0].status, 'READ');
ok('delivery receipts: delivered → read, never moves backwards');

msg = await wa(sharma, 'START'); assert.match(msg, /wapas chalu/);
await must(api('PATCH', '/api/admin/tenant', { token: A, body: { settings: { waCampaignDailyCap: 2 } } }));
const { campaign: wc2 } = await must(api('POST', '/api/admin/wa-campaigns', { token: A, body: { name: 'Capped', templateName: 'x', participantTypes: ['DEALER', 'MECHANIC'] } }), 201);
const wl2 = await must(api('POST', `/api/admin/wa-campaigns/${wc2.id}/launch`, { token: A }));
await must(api('POST', '/api/admin/wa-campaigns/run', { token: A }));
const capped = await q(`SELECT status, count(*)::int n FROM wa_campaign_recipients WHERE campaign_id=$1 GROUP BY 1`, [wc2.id]);
const sentN = capped.find((x) => x.status === 'SENT')?.n || 0;
assert.equal(sentN, 1); assert.ok(wl2.queued > 2); // 1 already sent today + 1 = cap 2
ok(`daily cap holds: ${sentN} sent, ${wl2.queued - sentN} wait for tomorrow`);

// ---------- 6. Points expiry ----------
const ex = await signup(31, 'MECHANIC', 'Expiry Test');
await scan(ex.token); await scan(ex.token); await scan(ex.token); await scan(ex.token); await scan(ex.token); // 100 pts
await q(`UPDATE ledger_entries SET created_at=now() - interval '7 months' WHERE participant_id=$1`, [ex.id]);
await scan(ex.token); await scan(ex.token); // 40 recent
await must(api('POST', `/api/admin/participants/${ex.id}/adjust`, { token: A, body: { points: -30, note: 'Correction', idempotencyKey: `adj-${run}` } }));
const r1 = await must(api('POST', '/api/admin/expiry/run', { token: A }));
assert.equal((await q(`SELECT balance FROM wallets WHERE participant_id=$1`, [ex.id]))[0].balance, 40);
const r2 = await must(api('POST', '/api/admin/expiry/run', { token: A }));
assert.equal((await q(`SELECT balance FROM wallets WHERE participant_id=$1`, [ex.id]))[0].balance, 40);
assert.ok(r1.points >= 70);
ok('FIFO expiry: 100 old − 30 already used = 70 expired, 40 recent kept; re-run is a no-op');

const soon = await signup(32, 'MECHANIC', 'Soon');
await scan(soon.token); await scan(soon.token);
await q(`UPDATE ledger_entries SET created_at=now() - interval '5 months' - interval '15 days' WHERE participant_id=$1`, [soon.id]);
const r3 = await must(api('POST', '/api/admin/expiry/run', { token: A }));
const exp = await q(`SELECT payload FROM events WHERE type='points.expiring' AND payload->>'participantId'=$1`, [soon.id]);
assert.equal(exp.length, 1); assert.equal(Number(exp[0].payload.points), 40); assert.ok(r3.reminders >= 1);
await must(api('POST', '/api/admin/expiry/run', { token: A }));
assert.equal((await q(`SELECT count(*)::int n FROM events WHERE type='points.expiring' AND payload->>'participantId'=$1`, [soon.id]))[0].n, 1);
ok('reminder 30 days before expiry, sent once a week at most');

// ---------- 7. Isolation + integrity ----------
assert.equal((await must(api('GET', '/api/admin/orders', { token: B }))).orders.length, 0);
assert.equal((await must(api('GET', `/api/admin/call-campaigns/${cc.id}/calls`, { token: B }))).calls.length, 0);
assert.equal((await api('POST', `/api/admin/call-campaigns/${cc.id}/launch`, { token: B })).status, 404);
ok('brand B cannot see or launch brand A orders / calls');

await tick();
const bad = await q(`SELECT w.participant_id FROM wallets w LEFT JOIN (SELECT participant_id, sum(points) s FROM ledger_entries GROUP BY 1) l ON l.participant_id=w.participant_id WHERE w.balance <> coalesce(l.s,0)`);
assert.equal(bad.length, 0); ok('ledger integrity after Phase 3 flows');

console.log(`\nAll ${passed} Phase 3 checks passed.`);
await pool.end();
process.exit(0);
