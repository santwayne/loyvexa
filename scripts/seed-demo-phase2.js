// Adds Phase 2 demo data to the "demo-auto" brand: dealers, Tally invoices, live schemes, a WhatsApp channel.
// Usage: node scripts/seed-demo-phase2.js   (run `npm run seed:demo` first; server must be running)
import { pool } from '../src/db/pool.js';

const BASE = process.env.BASE || 'http://localhost:4000';
const call = async (method, path, { token, key, body } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'X-Api-Key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`); return j;
};
const T = (await call('POST', '/api/auth/login', { body: { email: 'brand@demo-auto.in', password: 'Demo@12345' } })).token;
const { products } = await call('GET', '/api/admin/products', { token: T });
const sku = Object.fromEntries(products.map((p) => [p.sku, p]));

const { connectors } = await call('GET', '/api/admin/connectors', { token: T });
let key;
if (!connectors.find((c) => c.type === 'TALLY')) key = (await call('POST', '/api/admin/connectors', { token: T, body: { type: 'TALLY', name: 'Tally Prime – Head office' } })).apiKey;
else key = (await call('POST', `/api/admin/connectors/${connectors.find((c) => c.type === 'TALLY').id}/rotate-key`, { token: T })).apiKey;

const dealers = [
  ['LG-101', 'Gill Auto Store', '9814000101', 'Ludhiana'], ['LG-102', 'Sharma Spares', '9814000102', 'Jalandhar'],
  ['LG-103', 'Kohli Motors', '9814000103', 'Moga'], ['LG-104', 'Bajwa Auto Hub', '9814000104', 'Amritsar'],
  ['LG-105', 'Royal Bike Point', '9814000105', 'Patiala'], ['LG-106', 'Sandhu Traders', '9814000106', 'Bathinda'],
];
await call('POST', '/api/connect/parties', { key, body: dealers.map(([ref, name, mobile, city]) => ({ ledgerguid: ref, ledgername: name, mobile, city, type: 'dealers' })) });

const day = (n) => new Date(Date.now() + 5.5 * 3600e3 - n * 86400e3).toISOString().slice(0, 10);
const rows = []; let v = 0;
const spend = { 'LG-101': 135000, 'LG-102': 92000, 'LG-103': 61000, 'LG-104': 38000, 'LG-105': 155000, 'LG-106': 18000 };
for (const [ref, total] of Object.entries(spend)) {
  let left = total; let d = 9;
  while (left > 0) {
    const amt = Math.min(left, [25000, 40000, 18000, 32000][v % 4]); left -= amt; v++;
    const s = ['BRK-PAD-110', 'CLT-PLT-150', 'CHN-KIT-100'][v % 3];
    rows.push({ vchguid: `DEMO-VCH-${ref}-${v}`, vchnumber: `INV-${3000 + v}`, vchdate: day(d--), vchtype: 'Sales', ledgerguid: ref, itemsku: s, itemname: sku[s]?.name, quantity: Math.round(amt / 450), amount: amt });
  }
}
rows.push({ vchguid: 'DEMO-UNKNOWN-1', vchnumber: 'INV-3999', vchdate: day(1), vchtype: 'Sales', ledgerguid: 'LG-999', ledgername: 'Walia Auto (new party)', itemsku: 'BRK-PAD-110', quantity: 30, amount: 14000 });
const r = await call('POST', '/api/connect/invoices', { key, body: rows });
console.log('invoices', r);

const start = `${day(9)}T00:00:00+05:30`;
const end = new Date(Date.now() + 20 * 86400e3).toISOString();
const { schemes } = await call('GET', '/api/admin/schemes', { token: T });
if (!schemes.find((s) => s.name === 'Diwali Dhamaka 2026')) {
  await call('POST', '/api/admin/schemes', { token: T, body: { name: 'Diwali Dhamaka 2026', description: 'Kharido zyada, bonus pao — dealers ke liye', type: 'PURCHASE_SLAB', metric: 'AMOUNT', startsAt: start, endsAt: end, eligibleTypes: ['DEALER', 'DISTRIBUTOR'], status: 'ACTIVE',
    slabs: [{ min: 50000, rewardType: 'FIXED_POINTS', value: 500, label: 'Silver' }, { min: 100000, rewardType: 'PERCENT', value: 1.5, label: 'Gold' }, { min: 200000, rewardType: 'PERCENT', value: 2.5, label: 'Platinum' }] } });
  await call('POST', '/api/admin/schemes', { token: T, body: { name: 'Mechanic Mahotsav', description: '25 scans = 300 bonus points', type: 'SCAN_TARGET', metric: 'SCANS', startsAt: start, endsAt: end, eligibleTypes: ['MECHANIC'], status: 'ACTIVE',
    slabs: [{ min: 10, rewardType: 'FIXED_POINTS', value: 100, label: '10 scans' }, { min: 25, rewardType: 'FIXED_POINTS', value: 300, label: '25 scans' }] } });
  await call('POST', '/api/admin/schemes', { token: T, body: { name: 'Brake Pad Double Points', type: 'SCAN_MULTIPLIER', metric: 'SCANS', startsAt: start, endsAt: new Date(Date.now() + 7 * 86400e3).toISOString(), multiplier: 2, productIds: [sku['BRK-PAD-110'].id], status: 'ACTIVE' } });
}
await call('PUT', '/api/admin/channels/whatsapp', { token: T, body: { phoneNumberId: 'DEMO-PNID-001', displayNumber: '+91 98140 00000' } });
console.log('demo phase 2 ready. Tally API key:', key);
await pool.end();
