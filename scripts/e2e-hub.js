// End-to-end test of the Regulars hub connection (brand set-up, pause, SSO)
// against a running server. Needs the same HUB_SECRET as the server.
// Usage: BASE=http://localhost:4000 HUB_SECRET=… node scripts/e2e-hub.js
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { pool } from '../src/db/pool.js';

const BASE = process.env.BASE || 'http://localhost:4000';
const SECRET = process.env.HUB_SECRET;
const SUPER = { email: process.env.SUPER_ADMIN_EMAIL || 'admin@wayneesolutions.com', password: process.env.SUPER_ADMIN_PASSWORD || 'ChangeMe@123' };
if (!SECRET || SECRET.length < 32) { console.error('Set HUB_SECRET (32+ chars), same as the server'); process.exit(1); }
let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

async function api(method, path, { token, body, raw } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (raw) return { status: res.status, text };
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

// Exactly what Regulars' lib/hub/tokens.ts signs.
const hubToken = (purpose, sub, claims = {}, { aud = 'loyvexa', secret = SECRET, iss = 'regulars-hub' } = {}) =>
  jwt.sign({ ...claims, purpose }, secret, { algorithm: 'HS256', issuer: iss, audience: aud, subject: sub, jwtid: crypto.randomBytes(12).toString('hex'), expiresIn: 60 });

const run = Date.now().toString(36);
const bizId = `c_hub_${run}`;
const body = (active, extra = {}) => ({
  hubBusinessId: bizId, active, paidUntil: new Date(Date.now() + 30 * 864e5).toISOString(), plan: null,
  business: { name: `Shree Ganesh Auto Parts ${run}`, sector: 'MANUFACTURER', country: 'IN', timezone: 'Asia/Kolkata', phone: '+919814012345' },
  owner: { name: 'Gurpreet Singh', email: `owner+${run}@example.com`, phone: '+919814012345' },
  growth: { missedCallTextBack: false }, ...extra,
});

console.log('Hub connection');

// 1. First set-up creates the brand and the owner's admin login.
const t1 = hubToken('provision', bizId);
const a = await api('POST', '/api/hub/provision', { token: t1, body: body(true) });
assert.equal(a.status, 200, JSON.stringify(a.json));
assert.equal(a.json.status, 'ACTIVE');
assert.equal(a.json.data.created, true);
assert.match(a.json.data.slug, /^shree-ganesh-auto-parts/);
const tenantId = a.json.accountId;
const { rows: [admin] } = await pool.query(`SELECT * FROM admin_users WHERE tenant_id=$1`, [tenantId]);
assert.equal(admin.email, `owner+${run}@example.com`);
assert.equal(admin.role, 'TENANT_ADMIN');
ok('provision creates the brand + owner admin');

// 2. A token works once.
assert.equal((await api('POST', '/api/hub/provision', { token: t1, body: body(true) })).status, 401);
ok('a replayed hub token is refused');

// 3. Wrong secret / audience / purpose / business are refused.
assert.equal((await api('POST', '/api/hub/provision', { token: hubToken('provision', bizId, {}, { secret: 'x'.repeat(40) }), body: body(true) })).status, 401);
assert.equal((await api('POST', '/api/hub/provision', { token: hubToken('provision', bizId, {}, { aud: 'gmb' }), body: body(true) })).status, 401);
assert.equal((await api('POST', '/api/hub/provision', { token: hubToken('sso', bizId), body: body(true) })).status, 401);
assert.equal((await api('POST', '/api/hub/provision', { token: hubToken('provision', 'someone-else'), body: body(true) })).status, 401);
assert.equal((await api('POST', '/api/hub/provision', { body: body(true) })).status, 401);
ok('wrong secret, audience, purpose, business or no token → 401');

// 4. Same business again → same brand; active=false pauses it.
const p = await api('POST', '/api/hub/provision', { token: hubToken('provision', bizId), body: body(false) });
assert.equal(p.status, 200, JSON.stringify(p.json));
assert.equal(p.json.accountId, tenantId);
assert.equal(p.json.status, 'PAUSED');
assert.equal(p.json.data.created, false);
const { rows: [paused] } = await pool.query(`SELECT status, settings FROM tenants WHERE id=$1`, [tenantId]);
assert.equal(paused.status, 'SUSPENDED');
assert.equal(paused.settings.hub.businessId, bizId);
ok('a lapsed bundle pauses the same brand');

// 5. Single sign-on is refused while paused …
const s1 = await api('POST', '/api/hub/sso/exchange', { body: { token: hubToken('sso', bizId, { acct: tenantId, email: `owner+${run}@example.com`, next: '/admin/' }) } });
assert.equal(s1.status, 403);
ok('no sign-in while the brand is paused');

// 6. … and works after payment.
await api('POST', '/api/hub/provision', { token: hubToken('provision', bizId), body: body(true) });
const s2 = await api('POST', '/api/hub/sso/exchange', { body: { token: hubToken('sso', bizId, { acct: tenantId, email: `owner+${run}@example.com`, next: '/admin/' }) } });
assert.equal(s2.status, 200, JSON.stringify(s2.json));
assert.equal(s2.json.user.tenantId, tenantId);
assert.equal(s2.json.next, '/admin/');
const me = await api('GET', '/api/admin/tenant', { token: s2.json.token });
assert.equal(me.status, 200);
assert.equal(me.json.tenant.id, tenantId);
ok('SSO gives a brand-console session for that brand only');

// 7. An off-site "next" is never followed.
const s3 = await api('POST', '/api/hub/sso/exchange', { body: { token: hubToken('sso', bizId, { acct: tenantId, next: '//evil.example' }) } });
assert.equal(s3.json.next, '/admin/');
ok('off-site next is ignored');

// 8. Owner email already used elsewhere → placeholder login, SSO still works.
const biz2 = `c_hub2_${run}`;
const b2 = { ...body(true), hubBusinessId: biz2, business: { ...body(true).business, name: `Second Brand ${run}` } };
const a2 = await api('POST', '/api/hub/provision', { token: hubToken('provision', biz2), body: b2 });
assert.equal(a2.status, 200, JSON.stringify(a2.json));
assert.notEqual(a2.json.accountId, tenantId);
const { rows: [admin2] } = await pool.query(`SELECT email FROM admin_users WHERE tenant_id=$1`, [a2.json.accountId]);
assert.match(admin2.email, /@hub\.loyvexa\.invalid$/);
const s4 = await api('POST', '/api/hub/sso/exchange', { body: { token: hubToken('sso', biz2, { acct: a2.json.accountId, email: `owner+${run}@example.com` }) } });
assert.equal(s4.status, 200);
assert.equal(s4.json.user.tenantId, a2.json.accountId);
ok('owner email in use by another brand: placeholder login, SSO still into the right brand');

// 9. A token for one brand can't open another.
const s5 = await api('POST', '/api/hub/sso/exchange', { body: { token: hubToken('sso', biz2, { acct: tenantId }) } });
assert.equal(s5.status, 401);
ok('SSO token for one business cannot open another brand');

// 10. Super admin's Brands page data shows which brands came from the hub.
const sup = await api('POST', '/api/auth/login', { body: SUPER });
if (sup.status === 200) {
  const list = await api('GET', '/api/platform/tenants', { token: sup.json.token });
  const row = list.json.tenants.find((t) => t.id === tenantId);
  assert.equal(row.hub_business_id, bizId);
  const sus = await api('PATCH', `/api/platform/tenants/${tenantId}`, { token: sup.json.token, body: { status: 'SUSPENDED' } });
  assert.equal(sus.json.tenant.status, 'SUSPENDED');
  await api('PATCH', `/api/platform/tenants/${tenantId}`, { token: sup.json.token, body: { status: 'ACTIVE' } });
  ok('Brands list marks hub brands; suspend / activate works');
} else console.log('  - super admin login failed (run npm run seed first); skipped the Brands list check');

// 11. The SSO page is served.
const page = await api('GET', '/sso', { raw: true });
assert.equal(page.status, 200);
assert.match(page.text, /\/api\/hub\/sso\/exchange/);
ok('/sso page is served');

// 12. Bundle rules: the package's tools are kept; WhatsApp for this brand comes in through Regulars.
const t12 = await api('POST', '/api/hub/provision', { token: hubToken('provision', bizId), body: body(true, { tools: ['LOYVEXA', 'GMB'] }) });
assert.equal(t12.status, 200, JSON.stringify(t12.json));
const { rows: [tb] } = await pool.query(`SELECT settings FROM tenants WHERE id=$1`, [tenantId]);
assert.deepEqual(tb.settings.hub.tools, ['LOYVEXA', 'GMB']);
ok('provision keeps the package tools (no WAYNERING = no AI calls)');
const from = `9198140${run.slice(-5).replace(/\D/g, '7').padStart(5, '7')}`;
const inb = await api('POST', '/api/hub/whatsapp/inbound', { token: hubToken('whatsapp-inbound', bizId), body: { messages: [{ from, text: 'points', id: `wamid.${run}` }] } });
assert.equal(inb.status, 200, JSON.stringify(inb.json)); assert.equal(inb.json.handled, 1);
const { rows: msgs } = await pool.query(`SELECT direction FROM messages WHERE tenant_id=$1 AND peer=$2 ORDER BY id`, [tenantId, from]);
assert.deepEqual(msgs.map((m) => m.direction), ['IN', 'OUT']);
assert.equal((await api('POST', '/api/hub/whatsapp/inbound', { token: hubToken('provision', bizId), body: { messages: [] } })).status, 401);
ok('Regulars forwards a WhatsApp message → Loyvexa bot answers (wrong-purpose token refused)');

console.log(`\n${passed} passed`);
await pool.end();
