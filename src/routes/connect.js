import express, { Router } from 'express';
import { query } from '../db/pool.js';
import { ah, unauthorized, forbidden, badRequest } from '../lib/errors.js';
import { sha256 } from '../lib/codes.js';
import { parseDocuments, parseParties } from '../connectors/adapters.js';
import { ingestDocuments, upsertParties, matchParticipant } from '../services/invoices.js';
import { signParticipant } from '../middleware/auth.js';
import { forbidden as forbiddenErr, notFound } from '../lib/errors.js';

/**
 * Inbound API for accounting software / DMS. Auth = connector API key:
 *   X-Api-Key: lvx_xxx     (or Authorization: Bearer lvx_xxx)
 *
 * POST /api/connect/invoices   JSON (generic/Zoho/Tally-JSON/Royal), Tally XML, or CSV
 * POST /api/connect/parties    dealer master (any source)
 * POST /api/connect/royal      Royal order webhook (alias of /invoices for ROYAL connectors)
 */
const r = Router();
r.use(express.text({ type: ['text/*', 'application/xml', 'application/csv'], limit: '20mb' }));
r.use(express.json({ limit: '20mb' }));

const auth = ah(async (req, _res, next) => {
  const key = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!key) throw unauthorized('Missing API key');
  const { rows: [c] } = await query(`SELECT c.*, t.status AS tenant_status FROM connectors c JOIN tenants t ON t.id=c.tenant_id WHERE c.api_key_hash=$1`, [sha256(String(key))]);
  if (!c) throw unauthorized('Invalid API key');
  if (c.status !== 'ACTIVE' || c.tenant_status !== 'ACTIVE') throw forbidden('Connector disabled');
  req.connector = c;
  next();
});

const readBody = (req) => (typeof req.body === 'string' ? { rawText: req.body, body: tryJson(req.body) } : { rawText: null, body: req.body });
const tryJson = (s) => { try { return JSON.parse(s); } catch { return undefined; } };

const ingest = ah(async (req, res) => {
  const { body, rawText } = readBody(req);
  if (body == null && !rawText) throw badRequest('EMPTY_BODY', 'No documents in request');
  const docs = parseDocuments(req.connector.type, { body, rawText, config: req.connector.config });
  if (docs.length > 5000) throw badRequest('TOO_MANY', 'Send at most 5000 documents per request');
  res.json(await ingestDocuments({ connector: req.connector, docs }));
});

r.get('/ping', auth, (req, res) => res.json({ ok: true, connector: { id: req.connector.id, name: req.connector.name, type: req.connector.type } }));
r.post('/invoices', auth, ingest);
r.post('/royal', auth, ingest);
r.post('/parties', auth, ah(async (req, res) => {
  const { body } = readBody(req);
  const parties = parseParties(req.connector.type, body);
  if (!parties.length) throw badRequest('NO_PARTIES', 'No parties with a ref/id found');
  res.json({ received: parties.length, ...(await upsertParties({ tenantId: req.connector.tenant_id, connector: req.connector, parties })) });
}));

// Product master from the DMS / accounting software (SKU, name, prices). Upsert by SKU.
r.post('/products', auth, ah(async (req, res) => {
  const { body } = readBody(req);
  const rows = Array.isArray(body) ? body : body?.products || body?.items || (body ? [body] : []);
  const num = (v) => (v == null || v === '' ? null : Number(String(v).replace(/[^0-9.]/g, '')));
  let created = 0, updated = 0, skipped = 0;
  for (const p of rows) {
    const sku = String(p.sku ?? p.productCode ?? p.itemsku ?? p.code ?? '').trim();
    const name = String(p.name ?? p.productName ?? p.itemname ?? '').trim();
    if (!sku || !name) { skipped++; continue; }
    const price = num(p.price ?? p.dealerPrice ?? p.rate ?? p.unitPrice);
    const mrp = num(p.mrp);
    const r1 = await query(
      `INSERT INTO products (tenant_id, sku, name, category, mrp_paise, price_paise, external_ref, points)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0)
       ON CONFLICT (tenant_id, sku) DO UPDATE SET name=EXCLUDED.name, category=coalesce(EXCLUDED.category, products.category),
         mrp_paise=coalesce(EXCLUDED.mrp_paise, products.mrp_paise), price_paise=coalesce(EXCLUDED.price_paise, products.price_paise),
         external_ref=coalesce(EXCLUDED.external_ref, products.external_ref)
       RETURNING (xmax = 0) AS inserted`,
      [req.connector.tenant_id, sku, name, p.category ?? p.itemcategory ?? null, mrp != null ? Math.round(mrp * 100) : null,
        price != null ? Math.round(price * 100) : null, p.id ?? p._id ?? p.itemguid ?? null]);
    if (r1.rows[0].inserted) created++; else updated++;
  }
  res.json({ received: rows.length, created, updated, skipped, note: created ? 'New products earn 0 points per scan until the brand sets points in the console.' : undefined });
}));

/**
 * Partner token exchange (Korvo "Rewards" tab): the DMS backend, holding this connector's key,
 * swaps its dealer reference for a short-lived participant token, then calls /api/p/* as that dealer.
 * Only enabled when connector.config.allowTokenExchange is true. Never call this from a mobile app directly.
 */
r.post('/participant-token', auth, ah(async (req, res) => {
  if (!req.connector.config?.allowTokenExchange) throw forbiddenErr('Token exchange is not enabled for this connector');
  const b = req.body || {};
  const p = await matchParticipant({ query }, req.connector.tenant_id, { ref: b.externalRef, mobile: b.mobile, gstin: b.gstin });
  if (!p) throw notFound('Participant');
  if (p.status !== 'ACTIVE') throw forbiddenErr('Participant blocked');
  res.json({ token: signParticipant(p, '1h'), expiresIn: 3600, participant: { id: p.id, name: p.name, type: p.type } });
}));

export default r;
