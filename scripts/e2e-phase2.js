// Phase 2 end-to-end: connectors (Tally JSON + XML, Zoho Books, CSV/Busy, Royal), purchase points,
// slab schemes, scan multiplier, WhatsApp bot + notifications.
// Usage: BASE=http://localhost:4000 node scripts/e2e-phase2.js   (server must run with WHATSAPP_SEND_MODE=mock)
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';
import { tick } from '../src/worker.js';

const BASE = process.env.BASE || 'http://localhost:4000';
let passed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };
async function api(method, path, { token, key, body, text, ctype, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': ctype || 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'X-Api-Key': key } : {}), ...headers },
    body: text ?? (body ? JSON.stringify(body) : undefined),
  });
  const t = await res.text(); let json; try { json = JSON.parse(t); } catch { json = t; }
  return { status: res.status, json };
}
const must = async (p, s = 200) => { const r = await p; assert.equal(r.status, s, JSON.stringify(r.json)); return r.json; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = Date.now().toString(36);
const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); // IST date
const ymd = today.replace(/-/g, '');
const uniq = String(Date.now()).slice(-6);
const mob = (n) => `97${uniq}${String(n).padStart(2, '0')}`;

console.log('Loyvexa Phase 2 — end-to-end');
const superToken = (await must(api('POST', '/api/auth/login', { body: { email: 'admin@wayneesolutions.com', password: 'ChangeMe@123' } }))).token;
const slug = `p2-${run}`;
await must(api('POST', '/api/platform/tenants', { token: superToken, body: { name: 'Shakti Auto Parts', slug, settings: { purchasePointsPer1000: 10, burstScanLimit: 100 }, admin: { name: 'Owner', email: `o@${slug}.in`, password: 'Passw0rd!' } } }), 201);
const T = (await must(api('POST', '/api/auth/login', { body: { email: `o@${slug}.in`, password: 'Passw0rd!' } }))).token;
const { product: brk } = await must(api('POST', '/api/admin/products', { token: T, body: { sku: 'BRK-01', name: 'Brake Pad', points: 20 } }), 201);
const { product: clt } = await must(api('POST', '/api/admin/products', { token: T, body: { sku: 'CLT-02', name: 'Clutch Plate', points: 30, purchasePointsPerUnit: 2 } }), 201);
ok('brand + products (Clutch Plate earns 2 pts/unit on purchase)');

// ---------- Connectors ----------
const mk = async (type, name, config) => must(api('POST', '/api/admin/connectors', { token: T, body: { type, name, config } }), 201);
const tallyC = await mk('TALLY', 'Tally Prime – Ludhiana');
const zohoC = await mk('ZOHO_BOOKS', 'Zoho Books');
const busyC = await mk('BUSY', 'Busy export');
const royalC = await mk('ROYAL', 'Royal DMS', { earnOn: 'delivered' });
assert.ok(tallyC.apiKey.startsWith('lvx_') && tallyC.endpoints.invoices); ok('4 connectors created (Tally, Zoho, Busy, Royal) with one-time API keys');

assert.equal((await api('POST', '/api/connect/invoices', { key: 'lvx_wrong', body: {} })).status, 401);
assert.equal((await must(api('GET', '/api/connect/ping', { key: tallyC.apiKey }))).connector.type, 'TALLY'); ok('API key auth (bad key → 401, ping ok)');

// Dealer master from Tally ledgers
const parties = await must(api('POST', '/api/connect/parties', { key: tallyC.apiKey, body: [
  { ledgerguid: 'LG-A', ledgername: 'Gill Auto Store', mobile: mob(1), gstin: '03AAAAA1111A1Z1', city: 'Ludhiana' },
  { ledgerguid: 'LG-B', ledgername: 'Sharma Spares', mobile: mob(2), gstin: '03BBBBB2222B1Z2', city: 'Jalandhar' },
  { ledgerguid: 'LG-C', ledgername: 'No Phone Traders' },
] }));
assert.equal(parties.created, 2); assert.equal(parties.skipped, 1); ok('dealer master sync: 2 created, 1 without mobile skipped');

// Tally line-level JSON (same format Royal's Tally TDL already sends)
const tallyJson = [
  { cmpcode: 'SHK', vchguid: 'VCH-1', vchnumber: 'INV-1001', vchdate: today, vchtype: 'Sales', ledgerguid: 'LG-A', ledgername: 'Gill Auto Store', itemsku: 'BRK-01', itemname: 'Brake Pad', quantity: 100, rate: 500, amount: 50000 },
  { cmpcode: 'SHK', vchguid: 'VCH-1', vchnumber: 'INV-1001', vchdate: today, vchtype: 'Sales', ledgerguid: 'LG-A', ledgername: 'Gill Auto Store', itemsku: 'CLT-02', itemname: 'Clutch Plate', quantity: 60, rate: 500, amount: 30000 },
];
let s1 = await must(api('POST', '/api/connect/invoices', { key: tallyC.apiKey, body: tallyJson }));
assert.equal(s1.processed, 1); assert.equal(s1.pointsAwarded, 500 + 120); // ₹50k → 500 pts; clutch 60 units × 2
s1 = await must(api('POST', '/api/connect/invoices', { key: tallyC.apiKey, body: tallyJson }));
assert.equal(s1.duplicates, 1); assert.equal(s1.pointsAwarded, 0); ok('Tally JSON: ₹80k invoice → 620 pts (amount rate + per-unit override); re-push is a no-op');

// Tally XML export, matched by GSTIN
const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDATA>
  <TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Sales" ACTION="Create">
    <DATE>${ymd}</DATE><GUID>GUID-XML-77</GUID><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>INV-2001</VOUCHERNUMBER>
    <PARTYLEDGERNAME>Sharma Spares &amp; Co</PARTYLEDGERNAME><PARTYGSTIN>03BBBBB2222B1Z2</PARTYGSTIN>
    <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Brake Pad</STOCKITEMNAME><BILLEDQTY> 240 Nos</BILLEDQTY><AMOUNT>120000.00</AMOUNT></ALLINVENTORYENTRIES.LIST>
  </VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
const sx = await must(api('POST', '/api/connect/invoices', { key: tallyC.apiKey, text: xml, ctype: 'application/xml' }));
assert.equal(sx.processed, 1); assert.equal(sx.pointsAwarded, 1200); ok('Tally XML: matched dealer by GSTIN, product by item name → 1200 pts');

// Zoho Books invoice webhook, matched by GSTIN
const sz = await must(api('POST', '/api/connect/invoices', { key: zohoC.apiKey, body: { invoice: { invoice_id: 'Z-INV-9', invoice_number: 'ZB-009', date: today, customer_id: 'ZC-1', customer_name: 'Gill Auto', gst_no: '03AAAAA1111A1Z1', line_items: [{ sku: 'BRK-01', name: 'Brake Pad', quantity: 40, item_total: 20000 }], sub_total: 20000, total: 23600 } } }));
assert.equal(sz.pointsAwarded, 200); ok('Zoho Books: invoice on pre-GST value ₹20k → 200 pts');

// Busy CSV export: one known party (by mobile), one unknown
const csv = `Vch No,Vch Type,Date,Party Code,Party Name,Mobile,Item Code,Item Name,Qty,Taxable Value
B-501,Sales,${today.split('-').reverse().join('-')},BUSY-K,Kohli Motors,,BRK-01,Brake Pad,20,"10,000.00"
B-502,Sales,${today.split('-').reverse().join('-')},BUSY-A,Gill Auto,${mob(1)},CLT-02,Clutch Plate,10,5000`;
const sc = await must(api('POST', '/api/connect/invoices', { key: busyC.apiKey, text: csv, ctype: 'text/csv' }));
assert.equal(sc.created, 2); assert.equal(sc.unmatched, 1); assert.equal(sc.processed, 1); ok('Busy CSV (DD-MM-YYYY, "10,000.00"): 1 matched by mobile, 1 unmatched');

// Admin maps the unknown party → creates Kohli as dealer first
const { participant: kohli } = await must(api('POST', '/api/admin/participants', { token: T, body: { type: 'DEALER', name: 'Kohli Motors', mobile: mob(3), city: 'Moga' } }), 201);
const unmatched = (await must(api('GET', '/api/admin/invoices?status=UNMATCHED', { token: T }))).invoices;
assert.equal(unmatched.length, 1);
const asg = await must(api('POST', `/api/admin/invoices/${unmatched[0].id}/assign`, { token: T, body: { participantId: kohli.id } }));
assert.equal(asg.points, 100);
const sc2 = await must(api('POST', '/api/connect/invoices', { key: busyC.apiKey, text: `Vch No,Date,Party Code,Item Code,Qty,Amount\nB-503,${today},BUSY-K,BRK-01,10,7000`, ctype: 'text/csv' }));
assert.equal(sc2.processed, 1); assert.equal(sc2.unmatched, 0); ok('unmatched invoice assigned by admin; mapping remembered — next Busy invoice auto-matched');

// Credit note (Tally JSON) for Gill: ₹10k return → -100
const cn = await must(api('POST', '/api/connect/invoices', { key: tallyC.apiKey, body: [{ vchguid: 'VCH-CN-1', vchnumber: 'CN-11', vchdate: today, vchtype: 'Credit Note', ledgerguid: 'LG-A', itemsku: 'BRK-01', quantity: 20, amount: 10000 }] }));
assert.equal(cn.pointsReversed, 100); ok('credit note reverses 100 pts');

// Royal webhook: approved ignored (earnOn=delivered), delivered earns, returned reverses (capped)
const royalOrder = { orderNumber: `RO-${run}`, orderDate: `${today}T05:00:00Z`, dealerId: 'LG-B', dealerName: 'Sharma Spares', items: [{ productCode: 'BRK-01', productName: 'Brake Pad', quantity: 50, taxableValue: 25000, totalPrice: 29500 }], taxableValueTotal: 25000 };
const ra = await must(api('POST', '/api/connect/royal', { key: royalC.apiKey, body: { event: 'order.approved', order: { ...royalOrder, status: 'approved' } } }));
assert.equal(ra.received, 0);
const rd = await must(api('POST', '/api/connect/royal', { key: royalC.apiKey, body: { event: 'order.delivered', order: { ...royalOrder, status: 'delivered' } } }));
assert.equal(rd.pointsAwarded, 250);
const rr = await must(api('POST', '/api/connect/royal', { key: royalC.apiKey, body: { event: 'order.returned', order: { ...royalOrder, status: 'returned' } } }));
assert.equal(rr.pointsReversed, 250); ok('Royal webhook: approved → wait, delivered → +250, returned → −250');

// ---------- Schemes ----------
const now = Date.now();
const startsAt = new Date(now - 2 * 86400e3).toISOString();
const slabScheme = (await must(api('POST', '/api/admin/schemes', { token: T, body: {
  name: 'Diwali Dhamaka', description: 'Dealer purchase slabs', type: 'PURCHASE_SLAB', metric: 'AMOUNT', startsAt, endsAt: new Date(now + 10000).toISOString(), settleGraceDays: 0,
  eligibleTypes: ['DEALER'], slabs: [{ min: 100000, rewardType: 'PERCENT', value: 2, label: 'Gold' }, { min: 50000, rewardType: 'FIXED_POINTS', value: 500, label: 'Silver' }], status: 'ACTIVE',
} }), 201)).scheme;
assert.equal(slabScheme.slabs[0].label, 'Silver'); // sorted
const bad = await api('POST', '/api/admin/schemes', { token: T, body: { name: 'Bad', type: 'SCAN_TARGET', metric: 'AMOUNT', startsAt, endsAt: new Date(now + 1e6).toISOString(), slabs: [{ min: 1, rewardType: 'FIXED_POINTS', value: 1 }] } });
assert.equal(bad.status, 400); ok('slab scheme created (slabs auto-sorted); invalid metric rejected');

const lb = await must(api('GET', `/api/admin/schemes/${slabScheme.id}/leaderboard`, { token: T }));
const byName = Object.fromEntries(lb.rows.map((r) => [r.participant.name, r]));
assert.equal(byName['Gill Auto Store'].value, 95000);       // 80k + 20k + 5k − 10k
assert.equal(byName['Gill Auto Store'].slab.label, 'Silver');
assert.equal(byName['Gill Auto Store'].remainingToNext, 5000);
assert.equal(byName['Sharma Spares'].value, 120000);        // XML 1.2L; Royal 25k delivered then returned → net 0
assert.equal(byName['Sharma Spares'].points, 2400);         // 2% of ₹1.2L = ₹2,400 = 2400 pts
ok(`leaderboard: Gill ₹95,000 Silver (₹5,000 to Gold), Sharma ₹1,20,000 Gold → 2400 pts; projected ${lb.totals.projectedPoints}`);

// Mechanic + scan multiplier + scan target
const mult = (await must(api('POST', '/api/admin/schemes', { token: T, body: { name: 'Double Dhamaka', type: 'SCAN_MULTIPLIER', metric: 'SCANS', startsAt, endsAt: new Date(now + 3600e3).toISOString(), multiplier: 2, productIds: [brk.id], status: 'ACTIVE' } }), 201)).scheme;
const target = (await must(api('POST', '/api/admin/schemes', { token: T, body: { name: 'Mechanic Target', type: 'SCAN_TARGET', metric: 'SCANS', startsAt, endsAt: new Date(now + 10000).toISOString(), settleGraceDays: 0, eligibleTypes: ['MECHANIC'], slabs: [{ min: 3, rewardType: 'FIXED_POINTS', value: 100, label: '3 scans' }, { min: 10, rewardType: 'FIXED_POINTS', value: 500 }], status: 'ACTIVE' } }), 201)).scheme;
const otp = await must(api('POST', `/api/p/${slug}/auth/otp/request`, { body: { mobile: mob(9) } }));
const mech = (await must(api('POST', `/api/p/${slug}/auth/otp/verify`, { body: { mobile: mob(9), otp: otp.devOtp, name: 'Bittu Mechanic', type: 'MECHANIC', city: 'Ludhiana' } }), 201)).token;
const { batch: bb } = await must(api('POST', '/api/admin/qr-batches', { token: T, body: { productId: brk.id, quantity: 5 } }), 201);
const { batch: cb } = await must(api('POST', '/api/admin/qr-batches', { token: T, body: { productId: clt.id, quantity: 5 } }), 201);
const codesOf = async (b) => (await pool.query(`SELECT code FROM qr_codes WHERE batch_id=$1 ORDER BY serial_no`, [b.id])).rows.map((r) => r.code);
const bCodes = await codesOf(bb); const cCodes = await codesOf(cb);
const sc1 = await must(api('POST', '/api/p/scan', { token: mech, body: { code: bCodes[0] } }));
assert.equal(sc1.points, 20); assert.equal(sc1.bonus.points, 20); assert.equal(sc1.wallet.balance, 40);
const sc2b = await must(api('POST', '/api/p/scan', { token: mech, body: { code: cCodes[0] } }));
assert.equal(sc2b.bonus, null); ok('2x multiplier on Brake Pad only: 20 + 20 bonus; Clutch scan no bonus');

const ps = await must(api('GET', '/api/p/schemes', { token: mech }));
const tgt = ps.schemes.find((x) => x.name === 'Mechanic Target');
assert.equal(tgt.progress.value, 2); assert.equal(tgt.progress.remainingToNext, 1);
assert.ok(!ps.schemes.find((x) => x.name === 'Diwali Dhamaka')); ok('mechanic sees own schemes + progress (dealer scheme hidden)');

// ---------- WhatsApp ----------
const phoneNumberId = `PNID${uniq}${run}`;
await must(api('PUT', '/api/admin/channels/whatsapp', { token: T, body: { phoneNumberId, displayNumber: '+91 98XXXXXX00', accessToken: 'EAAG-test-token-not-real-0000', templates: { 'scheme.bonus': { name: 'scheme_bonus_v1', language: 'hi' } } } }));
const verify = await fetch(`${BASE}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=dev-verify-token&hub.challenge=12345`);
assert.equal(await verify.text(), '12345'); ok('WhatsApp channel connected (token encrypted); webhook verification ok');

const wa = (from, text, id) => api('POST', '/api/whatsapp/webhook', { body: { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { metadata: { phone_number_id: phoneNumberId }, contacts: [{ wa_id: from }], messages: [{ from, id, type: 'text', text: { body: text } }] } }] }] } });
const lastOut = async (peer) => (await pool.query(`SELECT body FROM messages WHERE peer=$1 AND direction='OUT' ORDER BY id DESC LIMIT 1`, [peer])).rows[0]?.body;
const gill = `91${mob(1)}`; const bittu = `91${mob(9)}`;

await must(api('POST', '/api/whatsapp/webhook', { body: { entry: [{ changes: [{ value: { metadata: { phone_number_id: phoneNumberId }, messages: [{ from: gill, id: `w1-${run}`, type: 'text', text: { body: 'points' } }] } }] }] } }));
assert.match(await lastOut(gill), /points/);
const gillWallet = (await pool.query(`SELECT balance FROM wallets w JOIN participants p ON p.id=w.participant_id WHERE p.mobile=$1`, [gill])).rows[0].balance;
assert.match(await lastOut(gill), new RegExp(gillWallet.toLocaleString('en-IN'))); ok(`bot "points" → dealer balance ${gillWallet}`);

await must(wa(gill, '2', `w2-${run}`));
const schemesMsg = await lastOut(gill);
assert.match(schemesMsg, /Diwali Dhamaka/); assert.match(schemesMsg, /₹95,000/); assert.match(schemesMsg, /₹5,000/);
ok('bot "2" → scheme progress with amount to next slab');
console.log(schemesMsg.split('\n').map((l) => `      │ ${l}`).join('\n'));

await must(wa(gill, '2', `w2-${run}`)); // Meta retry, same id
const cnt = (await pool.query(`SELECT count(*) n FROM messages WHERE peer=$1 AND direction='OUT'`, [gill])).rows[0].n;
assert.equal(Number(cnt), 2); ok('duplicate webhook delivery ignored');

await must(wa('919000000001', 'hi', `w3-${run}`));
assert.match(await lastOut('919000000001'), /registered nahi/); ok('unknown number → join link');

await must(wa(bittu, 'namaskarji', `w4-${run}`));
assert.match(await lastOut(bittu), /Mere points/);
const attempts = (await pool.query(`SELECT count(*) n FROM scan_attempts sa JOIN participants p ON p.id=sa.participant_id WHERE p.mobile=$1`, [bittu])).rows[0].n;
assert.equal(Number(attempts), 2); ok('chit-chat ("namaskarji") → menu, NOT a failed scan');

const pretty = bCodes[1].match(/.{4}/g).join('-');
await must(wa(bittu, pretty, `w5-${run}`));
assert.match(await lastOut(bittu), /\+40 points/); ok(`code sent on WhatsApp (${pretty}) → scanned, +40 incl. 2x bonus`);
await must(wa(bittu, 'english', `w6-${run}`));
assert.match(await lastOut(bittu), /My points/); ok('language switch to English');
await must(wa(bittu, '3', `w7-${run}`));
assert.match(await lastOut(bittu), /Last 5 transactions/); ok('bot "3" → history');

const sim = await must(api('POST', '/api/admin/whatsapp/simulate', { token: T, body: { from: mob(2), text: 'balance' } }));
assert.match(sim.reply, /points/); ok('console simulator works');

// one more scan for the target scheme (3 scans → slab 1)
await must(api('POST', '/api/p/scan', { token: mech, body: { code: cCodes[1] } }));

// ---------- Settlement ----------
const early = await api('POST', `/api/admin/schemes/${slabScheme.id}/settle`, { token: T });
if (Date.now() < now + 10000) { assert.equal(early.status, 409); ok('cannot settle before the scheme ends'); }
await sleep(Math.max(0, now + 10500 - Date.now()));
const w = await tick(); // worker: auto-settle + deliver notifications
const settledIds = w.settled.map((x) => x.scheme?.id);
assert.ok(settledIds.includes(slabScheme.id) && settledIds.includes(target.id));
const again = await must(api('POST', `/api/admin/schemes/${slabScheme.id}/settle`, { token: T }));
assert.equal(again.alreadySettled, true);
const bonus = (await pool.query(`SELECT p.name, l.points FROM ledger_entries l JOIN participants p ON p.id=l.participant_id WHERE l.type='SCHEME_BONUS' AND l.ref_type='scheme' AND l.ref_id LIKE $1 ORDER BY p.name`, [`${slabScheme.id}:%`])).rows;
assert.deepEqual(bonus.map((b) => [b.name, b.points]), [['Gill Auto Store', 500], ['Sharma Spares', 2400]]);
const tb = (await pool.query(`SELECT points FROM ledger_entries WHERE type='SCHEME_BONUS' AND ref_id LIKE $1`, [`${target.id}:%`])).rows;
assert.deepEqual(tb.map((x) => x.points), [100]);
ok(`worker auto-settled: Gill +500 (Silver), Sharma +2400 (Gold 2%), Bittu +100 (3 scans); re-settle is a no-op`);

const notes = (await pool.query(`SELECT peer, body FROM messages WHERE tenant_id=(SELECT id FROM tenants WHERE slug=$1) AND direction='OUT' AND body LIKE '%Badhai%' ORDER BY id`, [slug])).rows;
assert.ok(notes.length >= 3, JSON.stringify(notes));
const purchaseNote = (await pool.query(`SELECT count(*) n FROM messages WHERE tenant_id=(SELECT id FROM tenants WHERE slug=$1) AND body LIKE '%purchase%record%'`, [slug])).rows[0].n;
assert.ok(Number(purchaseNote) >= 3); ok(`WhatsApp notifications queued: ${notes.length} scheme-bonus, ${purchaseNote} purchase receipts`);

// ---------- Integrity ----------
const { rows: badW } = await pool.query(`
  SELECT w.participant_id FROM wallets w
   LEFT JOIN (SELECT participant_id, sum(points) s FROM ledger_entries GROUP BY 1) l ON l.participant_id=w.participant_id
  WHERE w.balance <> coalesce(l.s,0)`);
assert.equal(badW.length, 0);
const { rows: badInv } = await pool.query(`SELECT i.id FROM invoices i WHERE i.status='PROCESSED' AND i.base_points <> 0
  AND (SELECT count(*) FROM ledger_entries l WHERE l.ref_type='invoice' AND l.ref_id=i.id::text) <> 1`);
assert.equal(badInv.length, 0); ok('ledger integrity: wallets = ledger; every processed invoice posted exactly once');

console.log(`\nAll ${passed} Phase 2 checks passed.`);
await pool.end();
process.exit(0);
