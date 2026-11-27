// Regression tests for the bug report of 27 Nov 2026 (bugs #1, #3–#8; #2 is on the Loopdesk side).
// Usage: BASE=http://localhost:4000 node scripts/e2e-testing-report-3.js
//   (server running with WHATSAPP_SEND_MODE=mock, CALL_PROVIDER=mock; same DATABASE_URL here)
// Loopdesk (Regulars) and WayneRing are faked with a local HTTP server inside this script.
import assert from 'node:assert/strict';
import http from 'node:http';
import { pool } from '../src/db/pool.js';
import { config } from '../src/config.js';
import { classifyCallReport, getCallProvider } from '../src/services/calls/providers.js';
import { dispatchDue, settleCall, expireSilentCalls, completeFinishedCampaigns, launchCampaign } from '../src/services/calls/index.js';
import { handleInbound } from '../src/services/bot.js';
import { deliverEvent } from '../src/services/notifications.js';
import { clearTemplateCache, waNumber, checkChannel } from '../src/services/whatsapp.js';
import { scan } from '../src/services/scan.js';
import { progressFor, progressLine } from '../src/services/schemes.js';

const BASE = process.env.BASE || 'http://localhost:4000';
let passed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };
async function api(method, path, { token, body, raw } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let json; try { json = raw ? t : JSON.parse(t); } catch { json = t; }
  return { status: res.status, json };
}
const must = async (p, s = 200) => { const r = await p; assert.equal(r.status, s, JSON.stringify(r.json)); return r.json; };
const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
const run = Date.now().toString(36);
const uniq = String(Date.now()).slice(-5);
const ten = (n) => `96${uniq}${String(n).padStart(3, '0')}`; // 10-digit Indian mobile

// ---------- fake Loopdesk + WayneRing ----------
const fake = { templates: [], sent: [], optIn: [], sendError: null, optInStatus: 200, wayneringReply: { status: 200, body: { id: 'WR-1', status: 'queued' } } };
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    const body = b ? JSON.parse(b) : {};
    const send = (s, j) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.url.endsWith('/whatsapp/templates')) return send(200, { templates: fake.templates });
    if (req.url.endsWith('/whatsapp/send')) { fake.sent.push(body); return fake.sendError ? send(400, { error: fake.sendError }) : send(200, { messageId: `wamid.${fake.sent.length}` }); }
    if (req.url.endsWith('/whatsapp/opt-in')) { fake.optIn.push(body); return send(fake.optInStatus, fake.optInStatus === 200 ? { ok: true } : { error: 'nope' }); }
    if (req.url.endsWith('/api/v1/outbound-calls')) return send(fake.wayneringReply.status, fake.wayneringReply.body);
    send(404, {});
  });
});
await new Promise((r) => srv.listen(0, r));
const FAKE = `http://127.0.0.1:${srv.address().port}`;

console.log('Loyvexa — bug report 27 Nov 2026');
const superToken = (await must(api('POST', '/api/auth/login', { body: { email: 'admin@wayneesolutions.com', password: 'ChangeMe@123' } }))).token;
const slug = `tr3-${run}`;
await must(api('POST', '/api/platform/tenants', { token: superToken, body: { name: `Brand ${slug}`, slug, settings: { callHoursStart: 0, callHoursEnd: 24 }, admin: { name: 'Owner', email: `o@${slug}.in`, password: 'Passw0rd!' } } }), 201);
const A = (await must(api('POST', '/api/auth/login', { body: { email: `o@${slug}.in`, password: 'Passw0rd!' } }))).token;
let [tenant] = await q(`SELECT * FROM tenants WHERE slug=$1`, [slug]);
const add = (n, type = 'DEALER', name = `Dealer ${n}`) => must(api('POST', '/api/admin/participants', { token: A, body: { name, mobile: ten(n), type, city: 'Ludhiana' } }), 201).then((r) => r.participant);

// ---------- #1 WayneRing: "Nobody spoke" with no proof of dialling is FAILED – not dialled ----------
assert.deepEqual(classifyCallReport({ summary: 'Nobody spoke on the call' }).notDialled, true);
assert.equal(classifyCallReport({ status: 'completed', outcome: 'NO_ANSWER', summary: 'Nobody spoke on the call' }).failed, true);
assert.equal(classifyCallReport({ status: 'ended', ended_reason: 'customer-did-not-answer' }).outcome, 'NO_ANSWER');
assert.equal(classifyCallReport({ status: 'ended', ended_reason: 'customer-busy' }).outcome, 'NO_ANSWER');
assert.equal(classifyCallReport({ status: 'failed', ended_reason: 'twilio-failed-to-connect-call' }).notDialled, true);
assert.equal(classifyCallReport({ outcome: 'interested', duration: 45 }).outcome, 'INTERESTED');
assert.equal(classifyCallReport({ ended_reason: 'silence-timed-out', duration: 14 }).outcome, 'NO_ANSWER');

const p1 = await add(1); const p2 = await add(2); const p3 = await add(3);
const { campaign: cc } = await must(api('POST', '/api/admin/call-campaigns', { token: A, body: { name: 'mandeep call', script: 'WINBACK', participantTypes: ['DEALER'] } }), 201);
await q(`UPDATE call_campaigns SET provider='waynering' WHERE id=$1`, [cc.id]);
const launched = await launchCampaign({ tenantId: tenant.id, campaignId: cc.id });
assert.equal(launched.queued, 3);
config.calls.wayneringBaseUrl = FAKE;
// WayneRing accepts the first call but sends no ID; the others get IDs.
let n = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  if (String(url).includes('/outbound-calls')) { n++; fake.wayneringReply = n === 1 ? { status: 200, body: { status: 'queued' } } : { status: 200, body: { id: `WR-${run}-${n}`, status: 'queued' } }; }
  return realFetch(url, opts);
};
await dispatchDue();
globalThis.fetch = realFetch;
let rows = await q(`SELECT k.*, p.mobile FROM calls k JOIN participants p ON p.id=k.participant_id WHERE campaign_id=$1 ORDER BY k.created_at`, [cc.id]);
const noId = rows.find((k) => k.status === 'FAILED');
assert.ok(noId && noId.dial_failed && /not dialled/.test(noId.summary), JSON.stringify(rows.map((k) => [k.status, k.summary])));
const dialing = rows.filter((k) => k.status === 'DIALING');
assert.equal(dialing.length, 2);
assert.ok(dialing.every((k) => k.provider_call_id?.startsWith('WR-') && /WayneRing \(call ID/.test(k.summary)));
// Webhook: the exact report from the bug ("Nobody spoke on the call", no dial info)
const hook = (body) => api('POST', '/api/webhooks/calls/waynering', { body });
await must(hook({ id: dialing[0].provider_call_id, status: 'completed', summary: 'Nobody spoke on the call' }));
await must(hook({ id: dialing[1].provider_call_id, status: 'ended', ended_reason: 'customer-did-not-answer', duration: 0, summary: 'Nobody spoke on the call' }));
rows = await q(`SELECT * FROM calls WHERE campaign_id=$1`, [cc.id]);
const a = rows.find((k) => k.id === dialing[0].id); const b = rows.find((k) => k.id === dialing[1].id);
assert.equal(a.status, 'FAILED'); assert.equal(a.outcome, null); assert.ok(a.dial_failed && a.summary.startsWith('FAILED – not dialled'), a.summary);
assert.equal(a.provider_status, 'completed'); assert.equal(a.provider_detail.summary, 'Nobody spoke on the call');
assert.equal(b.status, 'COMPLETED'); assert.equal(b.outcome, 'NO_ANSWER'); assert.equal(b.provider_status, 'ended / customer-did-not-answer');
const list = await must(api('GET', `/api/admin/call-campaigns/${cc.id}/calls`, { token: A }));
assert.ok(list.calls.some((k) => k.dial_failed && k.provider_call_id));
const camps = await must(api('GET', '/api/admin/call-campaigns', { token: A }));
assert.equal(camps.campaigns.find((c) => c.id === cc.id).stats.notDialled, 2);
// A call WayneRing never reports on becomes FAILED – not dialled after the timeout
const p4 = await add(4);
const [stuckCamp] = await q(`INSERT INTO call_campaigns (tenant_id, name, script, provider, status, launched_at) VALUES ($1,'stuck','WINBACK','waynering','RUNNING',now()) RETURNING *`, [tenant.id]);
const [stuck] = await q(`INSERT INTO calls (tenant_id, campaign_id, participant_id, status, provider_call_id, attempted_at, context) VALUES ($1,$2,$3,'DIALING',$4, now() - interval '30 minutes', '{}') RETURNING *`, [tenant.id, stuckCamp.id, p4.id, `WR-stuck-${run}`]);
await expireSilentCalls(); await completeFinishedCampaigns();
const [st] = await q(`SELECT * FROM calls WHERE id=$1`, [stuck.id]);
assert.equal(st.status, 'FAILED'); assert.ok(st.dial_failed && /no result within 20 minutes/.test(st.summary) && st.summary.includes(`WR-stuck-${run}`), st.summary);
const [stC] = await q(`SELECT * FROM call_campaigns WHERE id=$1`, [stuckCamp.id]);
assert.equal(stC.status, 'FAILED');
ok('#1 call never dialled → FAILED – not dialled + reason (no ID, "Nobody spoke" w/o dial proof, no result in 20 min); WayneRing ID + dial status kept; real no-answer stays NO ANSWER');

// ---------- #6 test calls are TEST, not COMPLETED ----------
const p5 = await add(5);
const { campaign: tc } = await must(api('POST', '/api/admin/call-campaigns', { token: A, body: { name: 'test call', script: 'WINBACK', participantTypes: ['DEALER'] } }), 201);
const tl = await must(api('POST', `/api/admin/call-campaigns/${tc.id}/launch`, { token: A }));
assert.ok(tl.queued >= 1, JSON.stringify(tl)); // p1/p3 FAILED earlier must not block a new call (cooldown ignores FAILED/TEST)
await must(api('POST', '/api/admin/call-campaigns/dispatch', { token: A }));
const tcalls = await q(`SELECT status, test_mode FROM calls WHERE campaign_id=$1`, [tc.id]);
assert.ok(tcalls.length && tcalls.every((k) => k.status === 'TEST' && k.test_mode), JSON.stringify(tcalls));
const [tcc] = await q(`SELECT status FROM call_campaigns WHERE id=$1`, [tc.id]);
assert.equal(tcc.status, 'TEST');
const again = await settleCall({ callId: (await q(`SELECT id FROM calls WHERE campaign_id=$1 LIMIT 1`, [tc.id]))[0].id, outcome: 'INTERESTED' });
assert.equal(again.status, 'TEST'); // a late webhook never turns a test call into COMPLETED
assert.ok(p5);
ok('#6 mock calls → status TEST and campaign TEST (never COMPLETED); test calls do not count for the weekly cooldown');

// ---------- #7 scheme values in call script and WhatsApp campaign are the real numbers ----------
const { product } = await must(api('POST', '/api/admin/products', { token: A, body: { sku: `FT-${run}`, name: 'Flow Part', points: 10 } }), 201);
const { batch } = await must(api('POST', '/api/admin/qr-batches', { token: A, body: { productId: product.id, quantity: 3, label: 't' } }), 201);
const codes = (await q(`SELECT code FROM qr_codes WHERE batch_id=$1 ORDER BY serial_no`, [batch.id])).map((r) => r.code);
const mech = await add(6, 'MECHANIC', 'Raju');
await must(api('POST', '/api/admin/schemes', { token: A, body: { name: 'Flow Test Scheme', type: 'SCAN_TARGET', metric: 'SCANS', startsAt: new Date(Date.now() - 60e3).toISOString(), endsAt: new Date(Date.now() + 7 * 864e5).toISOString(), eligibleTypes: ['MECHANIC'], slabs: [{ min: 5, rewardType: 'FIXED_POINTS', value: 100 }], status: 'ACTIVE' } }), 201);
[tenant] = await q(`SELECT * FROM tenants WHERE id=$1`, [tenant.id]);
for (const c of codes.slice(0, 2)) { const r = await scan({ tenant, participantId: mech.id, input: c, deviceId: 'test' }); assert.ok(r.ok, JSON.stringify(r)); }
const [mp] = await q(`SELECT * FROM participants WHERE id=$1`, [mech.id]);
const line = progressLine((await progressFor({ tenant, participant: mp })).find((s) => s.name === 'Flow Test Scheme'), 'hi');
assert.equal(line, 'Flow Test Scheme: abhi 2 scans. Agla slab 5 scans pe (100 points) — sirf 3 scans aur');
const { campaign: mc } = await must(api('POST', '/api/admin/call-campaigns', { token: A, body: { name: 'mech call', script: 'SCHEME_REMINDER', participantTypes: ['MECHANIC'] } }), 201);
await must(api('POST', `/api/admin/call-campaigns/${mc.id}/launch`, { token: A }));
const [mcall] = await q(`SELECT context FROM calls WHERE campaign_id=$1`, [mc.id]);
assert.ok(mcall.context.firstMessage.includes(line), mcall.context.firstMessage);
assert.equal(mcall.context.vars.scheme_progress, line);
const { campaign: wc } = await must(api('POST', '/api/admin/wa-campaigns', { token: A, body: { name: 'mech wa', templateName: 'any_template', language: 'en', params: ['{name}', '{scheme}', '{scheme_progress}'], participantTypes: ['MECHANIC'] } }), 201);
await must(api('POST', `/api/admin/wa-campaigns/${wc.id}/launch`, { token: A }));
await must(api('POST', '/api/admin/wa-campaigns/run', { token: A }));
const [wmsg] = await q(`SELECT payload FROM messages WHERE tenant_id=$1 AND participant_id=$2 AND direction='OUT' AND payload->>'type'='template' ORDER BY created_at DESC LIMIT 1`, [tenant.id, mech.id]);
assert.deepEqual(wmsg.payload.template.components[0].parameters.map((x) => x.text), ['Raju', line, line]);
ok('#7 real scans / slab / remaining in call script AND WhatsApp campaign; {scheme} and {scheme_progress} work in both');

// ---------- #8 CSV import errors in plain language ----------
const imp = await must(api('POST', '/api/admin/participants/import', { token: A, body: { rows: [
  { name: 'Ok Dealer', mobile: ten(20), type: 'DEALER' },
  { name: 'No Mobile', type: 'DEALER' },
  { name: 'Excel Dealer', mobile: '9.198E+11' },
  { name: 'Short', mobile: '12345' },
  { name: '', mobile: ten(21), type: 'WIZARD' },
] } }));
assert.equal(imp.created, 1);
const errs = imp.errors.map((e) => e.error);
assert.equal(errs[0], 'Row 3: mobile number khali hai');
assert.equal(errs[1], 'Row 4: Excel ne number bigaad diya (9.198E+11) — mobile column ko Text format karke dobara save karo');
assert.match(errs[2], /^Row 5: mobile number galat hai: "12345"/);
assert.match(errs[3], /^Row 6: naam khali hai; type galat hai: "WIZARD"/);
assert.ok(!errs.join(' ').includes('expected string'));
ok('#8 CSV import: "Row 3: mobile number khali hai", Excel E+11 hint, bad number / name / type in plain words');

// ---------- WhatsApp through a fake Loopdesk (live mode inside this test process) ----------
const bizId = `biz-${run}`;
await q(`UPDATE tenants SET hub_business_id=$2 WHERE id=$1`, [tenant.id, bizId]);
Object.assign(config.whatsapp, { sendMode: 'live' });
config.regulars.apiUrl = FAKE;
if (!config.hub.secret || config.hub.secret.length < 32) config.hub.secret = 'x'.repeat(40);

// ---------- #5 reply goes to 91XXXXXXXXXX even if the number came in without 91 ----------
assert.equal(waNumber('8264161658'), '918264161658'); assert.equal(waNumber('08264161658'), '918264161658'); assert.equal(waNumber('+91 82641 61658'), '918264161658');
const channel = { tenant_id: tenant.id, tenant: { ...tenant, hub_business_id: bizId }, viaRegulars: true };
fake.sent = [];
await handleInbound({ channel, from: ten(2), text: 'points', providerMsgId: `in-${run}-1` });
assert.equal(fake.sent.at(-1).to, `91${ten(2)}`);
// Re-engagement error from Loopdesk while the dealer wrote a minute ago → reason says the window was open
fake.sendError = '(#131047) Re-engagement message';
await handleInbound({ channel, from: `91${ten(2)}`, text: 'scheme', providerMsgId: `in-${run}-2` });
fake.sendError = null;
const [re] = await q(`SELECT error, peer FROM messages WHERE tenant_id=$1 AND direction='OUT' ORDER BY created_at DESC LIMIT 1`, [tenant.id]);
assert.equal(re.peer, `91${ten(2)}`);
assert.match(re.error, /24-hour window was open.*different WhatsApp number/);
ok('#5 bot replies always go to 91… (raw 10-digit / 0-prefixed numbers fixed); a re-engagement failure inside 24 h says the reply left from a different number');

// ---------- #3 START: opt-out removed first, reply, and Unblock button when Loopdesk still blocks ----------
await q(`UPDATE participants SET wa_opt_out=true WHERE id=$1`, [p3.id]);
fake.optIn = []; fake.optInStatus = 404; fake.sendError = 'This person sent STOP to the business';
await handleInbound({ channel, from: ten(3), text: 'START', providerMsgId: `in-${run}-3` });
const [pp3] = await q(`SELECT wa_opt_out FROM participants WHERE id=$1`, [p3.id]);
assert.equal(pp3.wa_opt_out, false);
assert.equal(fake.optIn.length, 2); assert.deepEqual(fake.optIn[0], { to: `91${ten(3)}`, optIn: true }); // retried once
const [startMsg] = await q(`SELECT status, error FROM messages WHERE participant_id=$1 AND direction='OUT' ORDER BY created_at DESC LIMIT 1`, [p3.id]);
assert.equal(startMsg.status, 'FAILED');
assert.match(startMsg.error, /Unblock WhatsApp.*Loopdesk opt-in: Loopdesk does not have the opt-in endpoint/);
const plist = await must(api('GET', `/api/admin/participants?limit=200&q=${ten(3)}`, { token: A }));
assert.equal(plist.participants[0].wa_blocked_upstream, true); // → "Unblock WhatsApp" button shows
// once Loopdesk accepts the opt-in, START goes through
fake.optInStatus = 200; fake.sendError = null; fake.optIn = [];
await handleInbound({ channel, from: ten(3), text: 'start', providerMsgId: `in-${run}-4` });
const [startOk] = await q(`SELECT status FROM messages WHERE participant_id=$1 AND direction='OUT' ORDER BY created_at DESC LIMIT 1`, [p3.id]);
assert.equal(startOk.status, 'SENT'); assert.equal(fake.optIn.length, 1);
assert.equal((await must(api('GET', `/api/admin/participants?limit=200&q=${ten(3)}`, { token: A }))).participants[0].wa_blocked_upstream, false);
ok('#3 START: STOP cleared (Loyvexa + Loopdesk, 1 retry) before the reply; if Loopdesk still blocks, the reason says so and "Unblock WhatsApp" shows');

// ---------- #4 welcome template: real name + language from the approved list, never a guessed one ----------
const welcomeFor = async (num) => {
  const p = await add(num);
  const [evt] = await q(`SELECT * FROM events WHERE tenant_id=$1 AND type='participant.created' AND payload->>'participantId'=$2`, [tenant.id, p.id]);
  return { p, result: await deliverEvent(evt) };
};
fake.templates = [{ name: 'loyvexa_participant_created', language: 'hi', status: 'APPROVED', body: 'Namaste {{1}}, {{2}}' }];
clearTemplateCache(); fake.sent = [];
let w = await welcomeFor(30);
assert.equal(w.result, 'sent-template');
assert.deepEqual(fake.sent.at(-1).message.template.language, { code: 'hi' }); // was "en" → #132001
assert.equal(fake.sent.at(-1).message.template.name, 'loyvexa_participant_created');
fake.templates = [{ name: 'loyvexa_welcome', language: 'en_US', status: 'APPROVED' }, { name: 'other', language: 'en', status: 'REJECTED' }];
clearTemplateCache();
w = await welcomeFor(31);
assert.equal(fake.sent.at(-1).message.template.name, 'loyvexa_welcome'); assert.equal(fake.sent.at(-1).message.template.language.code, 'en_US');
fake.templates = [{ name: 'loyvexa_otp', language: 'en', status: 'APPROVED' }];
clearTemplateCache(); const before = fake.sent.length;
w = await welcomeFor(32);
assert.equal(w.result, 'no-template'); assert.equal(fake.sent.length, before); // nothing sent to Meta
const [wf] = await q(`SELECT status, error FROM messages WHERE participant_id=$1 AND direction='OUT'`, [w.p.id]);
assert.equal(wf.status, 'FAILED'); assert.match(wf.error, /template "loyvexa_participant_created" is not approved.*Loopdesk → WhatsApp templates.*loyvexa_otp \(en\)/);
const chk = await checkChannel(tenant.id); // WhatsApp page "Check connection" lists the missing templates
assert.ok(chk.problems.some((x) => /not approved.*loyvexa_participant_created \(participant\.created\)/.test(x)), JSON.stringify(chk.problems));
ok('#4 welcome uses the approved template\'s real name + language (hi / en_US / loyvexa_welcome); if none is approved nothing goes to Meta and the reason says what to create');

config.whatsapp.sendMode = 'mock';
srv.close();
console.log(`\nAll ${passed} bug-report checks passed.`);
await pool.end();
