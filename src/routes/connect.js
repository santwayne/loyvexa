import express, { Router } from 'express';
import { query } from '../db/pool.js';
import { ah, unauthorized, forbidden, badRequest } from '../lib/errors.js';
import { sha256 } from '../lib/codes.js';
import { parseDocuments, parseParties } from '../connectors/adapters.js';
import { ingestDocuments, upsertParties } from '../services/invoices.js';

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

export default r;
