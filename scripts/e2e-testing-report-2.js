// Regression tests for testing report 2 (26 Nov 2026, bugs #1–#12).
// Usage: BASE=http://localhost:4000 node scripts/e2e-testing-report-2.js
//   (server running with WHATSAPP_SEND_MODE=mock, CALL_PROVIDER=mock; same DATABASE_URL here)
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';
import { handleInbound } from '../src/services/bot.js';
import { progressLine } from '../src/services/schemes.js';
import { finishCampaign } from '../src/services/campaigns.js';
import { getCallProvider } from '../src/services/calls/providers.js';
import { canonicalCity } from '../src/lib/cities.js';
import { config } from '../src/config.js';

const BASE = process.env.BASE || 'http://localhost:4000';
let passed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };
async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let json; try { json = JSON.parse(t); } catch { json = t; }
  return { status: res.status, json };
}
const must = async (p, s = 200) => { const r = await p; assert.equal(r.status, s, JSON.stringify(r.json)); return r.json; };
const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
const run = Date.now().toString(36);
const uniq = String(Date.now()).slice(-5);
const mob = (n) => `95${uniq}${String(n).padStart(3, '0')}`;

console.log('Loyvexa — testing report 2 fixes');
const superToken = (await must(api('POST', '/api/auth/login', { body: { email: 'admin@wayneesolutions.com', password: 'ChangeMe@123' } }))).token;
const slug = `tr2-${run}`;
await must(api('POST', '/api/platform/tenants', { token: superToken, body: { name: `Brand ${slug}`, slug, settings: { callHoursStart: 0, callHoursEnd: 24 }, admin: { name: 'Owner', email: `o@${slug}.in`, password: 'Passw0rd!' } } }), 201);
const A = (await must(api('POST', '/api/auth/login', { body: { email: `o@${slug}.in`, password: 'Passw0rd!' } }))).token;
const [tenant] = await q(`SELECT * FROM tenants WHERE slug=$1`, [slug]);

// ---------- #10 one spelling per city ----------
assert.equal(canonicalCity('Ludihiana'), 'Ludhiana');
assert.equal(canonicalCity('  ludhiana '), 'Ludhiana');
assert.equal(canonicalCity('Jalandar'), 'Jalandhar');
assert.equal(canonicalCity('Ropar Kalan'), 'Ropar Kalan'); // unknown city is kept (tidied)
const o = await must(api('POST', `/api/p/${slug}/auth/otp/request`, { body: { mobile: mob(1) } }));
await must(api('POST', `/api/p/${slug}/auth/otp/verify`, { body: { mobile: mob(1), otp: o.devOtp, name: 'Raju', type: 'MECHANIC', city: 'Ludihiana' } }), 201);
assert.equal((await q(`SELECT city FROM participants WHERE tenant_id=$1 AND mobile=$2`, [tenant.id, `91${mob(1)}`]))[0].city, 'Ludhiana');
await q(`INSERT INTO participants (tenant_id, type, name, mobile, city) VALUES ($1,'MECHANIC','Old typo','91${mob(9)}','Ludihiana')`, [tenant.id]);
const { cities } = await must(api('GET', '/api/admin/cities', { token: A }));
assert.deepEqual(cities, ['Ludhiana']);
const info = await must(api('GET', `/api/p/${slug}/info`));
assert.equal(info.cities[0], 'Ludhiana'); assert.ok(!info.cities.includes('Ludihiana'));
ok('#10 "Ludihiana" is saved / re-spelled as "Ludhiana"; dropdown list has one spelling');

// ---------- #11 add dealer + CSV import ----------
const { participant: d1 } = await must(api('POST', '/api/admin/participants', { token: A, body: { name: 'Gill Auto Store', mobile: mob(2), type: 'DEALER', city: 'ludhiana' } }), 201);
assert.equal(d1.city, 'Ludhiana');
const imp = await must(api('POST', '/api/admin/participants/import', { token: A, body: { rows: [
  { name: 'Sharma Traders', mobile: mob(3), type: 'dealer', city: 'Jalandar' },
  { name: 'Gill again', mobile: mob(2) },
  { name: 'Bad number', mobile: '12' },
  { name: 'Mech', mobile: mob(4), type: 'MECHANIC' },
] } }));
assert.equal(imp.created, 2); assert.equal(imp.duplicates, 1); assert.equal(imp.errors.length, 1); assert.equal(imp.errors[0].row, 4);
assert.equal((await q(`SELECT city FROM participants WHERE tenant_id=$1 AND mobile=$2`, [tenant.id, `91${mob(3)}`]))[0].city, 'Jalandhar');
assert.equal((await q(`SELECT count(*)::int AS n FROM wallets w JOIN participants p ON p.id=w.participant_id WHERE p.tenant_id=$1`, [tenant.id]))[0].n, 4);
ok('#11 console can add one dealer and import a CSV (created / duplicates / row errors reported)');

// ---------- #1 STOP → START ----------
const channel = { tenant_id: tenant.id, tenant };
await handleInbound({ channel, from: `91${mob(2)}`, text: 'STOP' });
assert.equal((await q(`SELECT wa_opt_out FROM participants WHERE id=$1`, [d1.id]))[0].wa_opt_out, true);
const reply = await handleInbound({ channel, from: `91${mob(2)}`, text: 'START' });
assert.match(reply, /wapas chalu/);
assert.equal((await q(`SELECT wa_opt_out FROM participants WHERE id=$1`, [d1.id]))[0].wa_opt_out, false);
const [last] = await q(`SELECT status, body FROM messages WHERE tenant_id=$1 AND direction='OUT' ORDER BY id DESC LIMIT 1`, [tenant.id]);
assert.notEqual(last.status, 'FAILED'); assert.match(last.body, /wapas chalu/);
await handleInbound({ channel, from: `91${mob(2)}`, text: 'STOP' });
await handleInbound({ channel, from: `91${mob(2)}`, text: 'yes' });
assert.equal((await q(`SELECT wa_opt_out FROM participants WHERE id=$1`, [d1.id]))[0].wa_opt_out, false);
await handleInbound({ channel, from: `91${mob(2)}`, text: 'STOP' });
const un = await must(api('POST', `/api/admin/participants/${d1.id}/whatsapp-unblock`, { token: A }));
assert.equal(un.participant.wa_opt_out, false); assert.equal(un.loopdesk.ok, true);
ok('#1 START / YES clears STOP before the reply; reply is not FAILED; console "Unblock WhatsApp" works');

// ---------- #2 / #3 test-mode calls ----------
const prev = process.env.CALL_MOCK_OUTCOMES; delete process.env.CALL_MOCK_OUTCOMES;
const mockOut = await getCallProvider('mock').startCall({ callId: 'x', to: '919800000009' });
assert.equal(mockOut.result.outcome, null); assert.equal(mockOut.result.testMode, true); assert.match(mockOut.result.summary, /TEST MODE/);
if (prev !== undefined) process.env.CALL_MOCK_OUTCOMES = prev;
const cc = await must(api('GET', '/api/admin/call-campaigns', { token: A }));
assert.equal(cc.testMode, config.calls.provider === 'mock');
ok('#2/#3 mock calls are TEST MODE: no invented "Wrong number"; console is told calls are simulated');

// ---------- #4 script variables ----------
const line = progressLine({ name: 'Flow Test Scheme', type: 'SCAN_TARGET', metric: 'SCANS', progress: { value: 0, slab: null, points: 0, nextSlab: { min: 1, rewardType: 'FIXED_POINTS', value: 500 }, remainingToNext: 1 } }, 'hi');
assert.equal(line, 'Flow Test Scheme: abhi 0 scans. Agla slab 1 scan pe (500 points) — sirf 1 scan aur');
const amt = progressLine({ name: 'Diwali', type: 'PURCHASE_SLAB', metric: 'AMOUNT', progress: { value: 95000, slab: { label: 'Silver', rewardType: 'FIXED_POINTS', value: 500 }, points: 500, nextSlab: { min: 100000, rewardType: 'PERCENT', value: 2 }, remainingToNext: 5000 } }, 'en');
assert.match(amt, /₹95,000 so far\. Slab Silver reached \(500 points\)\. Next slab at ₹1,00,000 \(2% bonus\) — only ₹5,000 more/);
ok('#4 call script / campaign scheme line has units, slab and reward');

// ---------- #5 all failed → FAILED with reasons ----------
const { campaign: wc } = await must(api('POST', '/api/admin/wa-campaigns', { token: A, body: { name: 'Fail test', templateName: 'loyvexa_scheme_bonus', language: 'en', segments: [], participantTypes: ['DEALER'] } }), 201);
const l = await must(api('POST', `/api/admin/wa-campaigns/${wc.id}/launch`, { token: A }));
assert.equal(l.queued, 2);
await q(`UPDATE wa_campaign_recipients SET status='FAILED', error='WhatsApp API 400 (#132001): template does not exist' WHERE campaign_id=$1`, [wc.id]);
await finishCampaign(wc.id);
const [fc] = (await must(api('GET', '/api/admin/wa-campaigns', { token: A }))).campaigns.filter((c) => c.id === wc.id);
assert.equal(fc.status, 'FAILED'); assert.match(fc.note, /All 2 messages failed — WhatsApp API 400 \(#132001\)/);
const rec = await must(api('GET', `/api/admin/wa-campaigns/${wc.id}/recipients`, { token: A }));
assert.equal(rec.recipients.length, 2); assert.ok(rec.recipients.every((r) => r.status === 'FAILED' && r.error.includes('#132001')));
const { campaign: wc0 } = await must(api('POST', '/api/admin/wa-campaigns', { token: A, body: { name: 'Nobody', templateName: 'x', participantTypes: ['PAINTER'] } }), 201);
const l0 = await must(api('POST', `/api/admin/wa-campaigns/${wc0.id}/launch`, { token: A }));
assert.equal(l0.campaign.status, 'CANCELLED'); assert.match(l0.campaign.note, /^Not started/);
ok('#5 every message failed → campaign FAILED with the reason; per-person reasons; 0 recipients is not COMPLETED');

// ---------- #6 only approved templates (live mode) ----------
const { assertApprovedTemplate } = await import('../src/services/whatsapp.js');
const mode = config.whatsapp.sendMode; config.whatsapp.sendMode = 'live';
await assert.rejects(assertApprovedTemplate(tenant.id, 'loyvexa_scheme_bonus', 'en'), /not approved/);
config.whatsapp.sendMode = mode;
ok('#6 in live mode a template that is not APPROVED is refused (campaign not created / launched)');

// ---------- #7 Plan now gives reasons ----------
const plan = await must(api('POST', '/api/admin/ai/plan', { token: A }));
assert.equal(plan.planned, 0); assert.ok(plan.reasons.length >= 3);
assert.ok(plan.reasons.some((r) => /switched off/.test(r))); assert.ok(plan.reasons.some((r) => /Slab push/.test(r)));
ok('#7 "Plan now" with 0 plans says why');

// ---------- #8 defaults visible, blank = default ----------
const ai0 = await must(api('GET', '/api/admin/ai', { token: A }));
assert.equal(ai0.defaults.aiMaxTouchesPerWeek, 2); assert.equal(ai0.defaults.aiWinbackMinRupees, 25000); assert.equal(ai0.defaults.aiSlabPushDays, 10);
assert.ok(!ai0.custom.includes('aiDailyCap'));
await must(api('PATCH', '/api/admin/ai/settings', { token: A, body: { aiDailyCap: 7 } }));
assert.ok((await must(api('GET', '/api/admin/ai', { token: A }))).custom.includes('aiDailyCap'));
await must(api('PATCH', '/api/admin/ai/settings', { token: A, body: { reset: ['aiDailyCap'] } }));
const ai2 = await must(api('GET', '/api/admin/ai', { token: A }));
assert.ok(!ai2.custom.includes('aiDailyCap')); assert.equal(ai2.settings.aiDailyCap, ai2.defaults.aiDailyCap);
ok('#8 defaults are sent for the placeholders; clearing a box goes back to the default');

// ---------- #12 CSV upload feedback ----------
const { connector } = await must(api('POST', '/api/admin/connectors', { token: A, body: { type: 'TALLY', name: 'Tally' } }), 201);
const csv = `invoice_no,date,party mobile,sku,qty,amount\nINV-1,2026-11-20,${mob(2)},X-1,10,5000\nINV-2,2026-11-21,${mob(3)},X-1,5,2500\n`;
const up = await must(api('POST', `/api/admin/connectors/${connector.id}/upload`, { token: A, body: { content: csv } }));
assert.equal(up.rows, 2); assert.equal(up.received, 2); assert.equal(up.created, 2); assert.equal(up.format, 'CSV');
const bad = await api('POST', `/api/admin/connectors/${connector.id}/upload`, { token: A, body: { content: 'name,phone\nfoo,bar\n' } });
assert.equal(bad.status, 400); assert.match(bad.json.error.message, /invoice number, date and amount/);
const list = await must(api('GET', '/api/admin/connectors', { token: A }));
assert.equal(list.connectors.find((c) => c.id === connector.id).documents, 2);
ok('#12 CSV on a Tally connector is read as CSV; result has row / document counts; bad file gives a clear error');

console.log(`\nAll ${passed} testing-report-2 checks passed.`);
await pool.end();
