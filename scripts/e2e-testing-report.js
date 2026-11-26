// Regression tests for the Nov 2026 testing report (bugs #1–#4, improvements #5–#6).
// Usage: BASE=http://localhost:4000 node scripts/e2e-testing-report.js   (server running, WHATSAPP_SEND_MODE=mock, CALL_PROVIDER=mock)
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';

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
const mob = (n) => `97${uniq}${String(n).padStart(3, '0')}`;

console.log('Loyvexa — testing report fixes');
const superToken = (await must(api('POST', '/api/auth/login', { body: { email: 'admin@wayneesolutions.com', password: 'ChangeMe@123' } }))).token;
const slug = `tr-${run}`;
await must(api('POST', '/api/platform/tenants', { token: superToken, body: { name: `Brand ${slug}`, slug, settings: { callHoursStart: 0, callHoursEnd: 24 }, admin: { name: 'Owner', email: `o@${slug}.in`, password: 'Passw0rd!' } } }), 201);
const A = (await must(api('POST', '/api/auth/login', { body: { email: `o@${slug}.in`, password: 'Passw0rd!' } }))).token;
const tenantId = (await q(`SELECT id FROM tenants WHERE slug=$1`, [slug]))[0].id;

const signup = async (n, type, name, city) => {
  const o = await must(api('POST', `/api/p/${slug}/auth/otp/request`, { body: { mobile: mob(n) } }));
  const v = await api('POST', `/api/p/${slug}/auth/otp/verify`, { body: { mobile: mob(n), otp: o.devOtp, name, type, city } });
  assert.ok([200, 201].includes(v.status), JSON.stringify(v.json));
  return v.json.token;
};
const { product } = await must(api('POST', '/api/admin/products', { token: A, body: { sku: 'TR-1', name: 'Clutch Plate', points: 10 } }), 201);
const { batch } = await must(api('POST', '/api/admin/qr-batches', { token: A, body: { productId: product.id, quantity: 10 } }), 201);
const codes = (await q(`SELECT code FROM qr_codes WHERE batch_id=$1 ORDER BY serial_no`, [batch.id])).map((r) => r.code);

// ---------- #1 Fraud flags ----------
const mandeep = await signup(1, 'MECHANIC', 'Mandeep', '  ludhiana ');
await must(api('POST', '/api/p/scan', { token: mandeep, body: { code: codes[0] } }));
for (let i = 0; i < 3; i++) await must(api('GET', `/api/public/verify/${codes[0]}`)); // claimed code checked again ×3
const flags = (await must(api('GET', '/api/admin/fraud-flags', { token: A }))).flags;
const reused = flags.filter((f) => f.rule === 'REUSED_CODE_CHECKED');
assert.equal(reused.length, 1, 'one open flag per code, not one per check');
assert.equal(reused[0].details.code, codes[0]);
const dash = await must(api('GET', '/api/admin/dashboard', { token: A }));
assert.ok(dash.authenticity.reused_code_checks >= 3 && dash.kpis.open_fraud_flags >= 1);
ok('#1 reused code checked on public page → fraud flag (de-duplicated); dashboard and flags page agree');

await q(`UPDATE qr_codes SET status='VOID' WHERE code=$1`, [codes[1]]);
await must(api('GET', `/api/public/verify/${codes[1]}`));
assert.ok((await must(api('GET', '/api/admin/fraud-flags', { token: A }))).flags.some((f) => f.rule === 'VOID_CODE_CHECKED'));
ok('#1 cancelled code checked → VOID_CODE_CHECKED flag');

for (let i = 0; i < 6; i++) await must(api('POST', '/api/p/scan', { token: mandeep, body: { code: codes[0] } })).catch(() => {});
const dup = (await must(api('GET', '/api/admin/fraud-flags', { token: A }))).flags.filter((f) => f.rule === 'REPEATED_DUPLICATE_SCANS');
assert.equal(dup.length, 1);
await must(api('POST', '/api/p/scan', { token: mandeep, body: { code: codes[2] } })); // still not locked out
ok('#1 re-scanning own code 6× → one flag, but scanning is NOT blocked');

// ---------- #2 WhatsApp ----------
const chk = await must(api('GET', '/api/admin/channels/whatsapp/check', { token: A }));
assert.equal(chk.ok, false);
assert.ok(chk.problems.some((p) => p.includes('MOCK mode')));
assert.ok(chk.problems.some((p) => p.includes('No WhatsApp number')));
ok('#2 connection check explains why replies do not reach the phone (mock mode, no number)');
const { metaError } = await import('../src/services/whatsapp.js');
const msg = metaError({ error: { code: 131030, message: 'Recipient phone number not in allowed list', error_data: { details: 'Recipient not in list' } } }, 400);
assert.ok(msg.includes('#131030') && msg.includes('development mode'));
ok('#2 Meta errors carry the code and a plain-language fix');

// ---------- #3 AI Manager settings ----------
const ai = await must(api('GET', '/api/admin/ai', { token: A }));
const autonomy = Object.fromEntries(ai.types.map((t) => [t.type, 'APPROVE'])); // exactly what the console sends
await must(api('PATCH', '/api/admin/ai/settings', { token: A, body: { aiEnabled: true, aiBriefHour: 9, aiBriefNumbers: ['7087064479'], aiDailyCap: 5, aiAutonomy: autonomy } }));
const saved = (await must(api('GET', '/api/admin/ai', { token: A }))).settings;
assert.equal(saved.aiEnabled, true);
assert.deepEqual(saved.aiBriefNumbers, ['917087064479']);
assert.equal(saved.aiMaxTouchesPerWeek, 2); // blank field left out → default kept
ok('#3 tester\'s exact settings save; number gets 91; blank fields keep defaults');
await q(`UPDATE tenants SET settings = settings || '{"aiSlabPushDays": null}'::jsonb WHERE id=$1`, [tenantId]);
assert.equal((await must(api('GET', '/api/admin/ai', { token: A }))).settings.aiSlabPushDays, 10);
const bad = await api('PATCH', '/api/admin/ai/settings', { token: A, body: { aiDailyCap: 0 } });
assert.equal(bad.status, 400); assert.ok(bad.json.error.message.includes('aiDailyCap'));
ok('#3 a null saved earlier no longer blanks the field; errors name the wrong field');

// ---------- #4/#5/#6 AI calls + city ----------
const city = (await q(`SELECT city FROM participants WHERE mobile=$1`, [`91${mob(1)}`]))[0].city;
assert.equal(city, 'Ludhiana');
ok('#6 "  ludhiana " is saved as "Ludhiana"');
const pv = await must(api('POST', '/api/admin/call-campaigns/preview', { token: A, body: { segments: ['NEW'], participantTypes: ['MECHANIC'], city: 'LUDHIANA' } }));
assert.equal(pv.count, 1); assert.equal(pv.sample[0].name, 'Mandeep');
ok('#5/#6 preview: NEW + MECHANIC + "LUDHIANA" → 1 match (case-insensitive)');
const pv0 = await must(api('POST', '/api/admin/call-campaigns/preview', { token: A, body: { participantTypes: ['MECHANIC'], city: 'ludihiana' } }));
assert.equal(pv0.count, 0);
assert.ok(pv0.reasons.some((r) => r.includes('ludihiana')));
assert.ok(pv0.cities.some((c) => c.city === 'Ludhiana'));
ok('#5 0 matches → reason + list of real cities (catches the "ludihiana" typo)');

const { campaign: c0 } = await must(api('POST', '/api/admin/call-campaigns', { token: A, body: { name: 'Zero test', script: 'FEEDBACK', city: 'ludihiana' } }), 201);
const l0 = await must(api('POST', `/api/admin/call-campaigns/${c0.id}/launch`, { token: A }));
assert.equal(l0.queued, 0); assert.notEqual(l0.campaign.status, 'COMPLETED'); assert.ok(l0.campaign.note.startsWith('Not started'));
ok('#4 0 calls → campaign is NOT "COMPLETED"; it says why');

const { campaign: c1 } = await must(api('POST', '/api/admin/call-campaigns', { token: A, body: { name: 'Real test', script: 'FEEDBACK', city: 'ludhiana', segments: ['NEW'], participantTypes: ['MECHANIC'] } }), 201);
const l1 = await must(api('POST', `/api/admin/call-campaigns/${c1.id}/launch`, { token: A }));
assert.equal(l1.queued, 1);
await must(api('POST', '/api/admin/call-campaigns/dispatch', { token: A }));
const calls = (await must(api('GET', `/api/admin/call-campaigns/${c1.id}/calls`, { token: A }))).calls;
assert.equal(calls.length, 1);
ok('#4 tester\'s filters (NEW + MECHANIC + Ludhiana) now queue and dial Mandeep');

const info = await must(api('GET', `/api/p/${slug}/info`));
assert.ok(info.cities.includes('Ludhiana'));
ok('#6 sign-up screen gets a city list');

// ---------- #7 Redemption ----------
const mId = (await q(`SELECT id FROM participants WHERE mobile=$1`, [`91${mob(1)}`]))[0].id;
await must(api('POST', `/api/admin/participants/${mId}/adjust`, { token: A, body: { points: 500, note: 'test credit', idempotencyKey: `tr-${run}` } }));
await must(api('PATCH', '/api/p/me', { token: mandeep, body: { upiId: 'mandeep@okaxis' } }));
const before = (await must(api('GET', '/api/p/me', { token: mandeep }))).wallet;
const { redemption } = await must(api('POST', '/api/p/redeem', { token: mandeep, body: { points: 200 } }), 201);
const during = (await must(api('GET', '/api/p/me', { token: mandeep }))).wallet;
assert.equal(during.held, 200); assert.equal(during.balance, before.balance - 200);
const pend = (await must(api('GET', '/api/p/redemptions', { token: mandeep }))).redemptions[0];
assert.equal(pend.status, 'REQUESTED');
ok('#7 cash-out request holds points; app gets REQUESTED (shown as "Payout pending")');
await must(api('POST', `/api/admin/redemptions/${redemption.id}/reject`, { token: A, body: { reason: 'Wrong UPI name' } }));
const after = (await must(api('GET', '/api/p/me', { token: mandeep }))).wallet;
assert.equal(after.held, 0); assert.equal(after.balance, before.balance);
const rej = (await must(api('GET', '/api/p/redemptions', { token: mandeep }))).redemptions[0];
assert.equal(rej.status, 'REJECTED'); assert.equal(rej.failure_reason, 'Wrong UPI name');
const ev = await q(`SELECT payload FROM events WHERE type='redemption.rejected' AND payload->>'redemptionId'=$1`, [redemption.id]);
assert.equal(ev.length, 1); assert.equal(Number(ev[0].payload.points), 200);
ok('#7 reject → all 200 points back in balance, reason visible in app, WhatsApp notice event raised');

// ---------- #8 Templates ----------
const tl = await must(api('GET', '/api/admin/wa-templates', { token: A }));
assert.ok(Array.isArray(tl.templates) && tl.note);
ok('#8 template list endpoint answers (and says what is missing when no number / WABA ID)');

console.log(`\nAll ${passed} testing-report checks passed.`);
await pool.end();
