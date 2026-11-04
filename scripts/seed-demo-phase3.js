// Phase 3 demo data for the "demo-auto" brand: dealer prices, mechanics in every segment,
// an AI call campaign, a WhatsApp order and a WhatsApp campaign.
// Usage: npm run seed:demo && npm run seed:demo2 && node scripts/seed-demo-phase3.js   (server running)
import { pool } from '../src/db/pool.js';
import { tick } from '../src/worker.js';

const BASE = process.env.BASE || 'http://localhost:4000';
const call = async (method, path, body, token) => {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`); return j;
};
const T = (await call('POST', '/api/auth/login', { email: 'brand@demo-auto.in', password: 'Demo@12345' })).token;
await call('PATCH', '/api/admin/tenant', { settings: { callHoursStart: 0, callHoursEnd: 24, pointsExpiryMonths: 12 } }, T);
const { products } = await call('GET', '/api/admin/products', null, T);
const prices = { 'BRK-PAD-110': 45000, 'CLT-PLT-150': 82000, 'CHN-KIT-100': 135000 };
for (const p of products) if (prices[p.sku]) await call('PATCH', `/api/admin/products/${p.id}`, { pricePaise: prices[p.sku] }, T);

const { rows: [t] } = await pool.query(`SELECT id FROM tenants WHERE slug='demo-auto'`);
const mechs = [['Harjit Mechanic', '9815000110', 'Ludhiana', 2], ['Bunty Auto Works', '9815000114', 'Jalandhar', 28], ['Raju Bike Care', '9815000119', 'Moga', 60],
  ['Vicky Garage', '9815000120', 'Patiala', 70], ['Sonu Repairs', '9815000123', 'Amritsar', 5], ['Kala Mechanic', '9815000127', 'Bathinda', 33]];
for (const [name, mobile, city, idleDays] of mechs) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO participants (tenant_id, type, name, mobile, city, created_at, last_scan_at) VALUES ($1,'MECHANIC',$2,$3,$4, now() - interval '120 days', now() - make_interval(days => $5))
     ON CONFLICT (tenant_id, mobile) DO UPDATE SET last_scan_at=EXCLUDED.last_scan_at, created_at=EXCLUDED.created_at RETURNING id`, [t.id, name, `91${mobile}`, city, idleDays]);
  await pool.query(`INSERT INTO wallets (participant_id, tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [p.id, t.id]);
}
await pool.query(`UPDATE participants SET created_at = now() - interval '60 days' WHERE tenant_id=$1 AND type IN ('DEALER','DISTRIBUTOR')`, [t.id]);
await call('POST', '/api/admin/segments/recompute', {}, T);

const { campaign } = await call('POST', '/api/admin/call-campaigns', { name: 'Win back dormant mechanics', script: 'WINBACK', language: 'hi', segments: ['DORMANT', 'AT_RISK'], participantTypes: ['MECHANIC'] }, T);
await call('POST', `/api/admin/call-campaigns/${campaign.id}/launch`, {}, T);
await call('POST', '/api/admin/call-campaigns/dispatch', {}, T);

// A dealer orders on WhatsApp through the bot simulator
for (const text of ['order', '1 20', '2 10', 'confirm']) await call('POST', '/api/admin/whatsapp/simulate', { from: '9814000101', text }, T);
const { campaign: wc } = await call('POST', '/api/admin/wa-campaigns', { name: 'Diwali scheme push', templateName: 'scheme_push_v1', language: 'hi', params: ['{name}', '{scheme_progress}'], previewText: 'Namaste {name}! {scheme_progress}', participantTypes: ['DEALER'] }, T);
await call('POST', `/api/admin/wa-campaigns/${wc.id}/launch`, {}, T);
await tick({ force: true });
console.log('demo phase 3 ready');
await pool.end();
