import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { badRequest } from '../lib/errors.js';
import { encrypt, newApiKey } from '../lib/crypto.js';
import { sha256 } from '../lib/codes.js';

/**
 * Link a brand to its Korvo company: create (or re-key) the brand's Korvo
 * connector here, then ask Korvo to switch the link on for the company with
 * this code. Korvo answers with the key Loyvexa uses to send WhatsApp orders.
 *
 * Used by the console button (POST /api/admin/korvo/link) and, for a
 * Loopdesk Distributor Pack, by the hub's provision call (fault L4), so the
 * link no longer has to be made by hand.
 */
export async function linkKorvo(tenant, { companyCode, korvoBaseUrl, earnOn = 'delivered', active = true }) {
  if (config.hubSecret.length < 32) throw badRequest('HUB_NOT_CONFIGURED', 'HUB_SECRET_KORVO is not set on Loyvexa (32+ characters, same value as HUB_SECRET on Korvo)');
  const base = (korvoBaseUrl || tenant.korvo?.baseUrl || config.korvo.baseUrl || '').replace(/\/$/, '');
  if (!base) throw badRequest('NO_KORVO_URL', 'Korvo URL is missing (KORVO_BASE_URL or korvoBaseUrl)');

  const key = newApiKey('lvx');
  const { rows: [existing] } = await query(`SELECT * FROM connectors WHERE tenant_id=$1 AND type='ROYAL' ORDER BY created_at LIMIT 1`, [tenant.id]);
  const cfg = { ...(existing?.config || {}), allowTokenExchange: true, earnOn };
  const connector = existing
    ? (await query(`UPDATE connectors SET api_key_hash=$2, api_key_prefix=$3, config=$4, status='ACTIVE' WHERE id=$1 RETURNING *`, [existing.id, sha256(key), key.slice(0, 10), cfg])).rows[0]
    : (await query(`INSERT INTO connectors (tenant_id, type, name, api_key_hash, api_key_prefix, config) VALUES ($1,'ROYAL','Korvo DMS',$2,$3,$4) RETURNING *`, [tenant.id, sha256(key), key.slice(0, 10), cfg])).rows[0];

  const token = jwt.sign({ purpose: 'provision' }, config.hubSecret, { algorithm: 'HS256', issuer: 'loyvexa', audience: 'korvo', subject: tenant.id, expiresIn: 60, jwtid: crypto.randomBytes(12).toString('hex') });
  let j;
  try {
    const resp = await fetch(`${base}/api/v1/hub/provision`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ companyCode, tenantSlug: tenant.slug, baseUrl: config.publicBaseUrl, connectorKey: key, earnOn, active, rotateKey: !tenant.korvo?.apiKeyEnc }),
      signal: AbortSignal.timeout(20000),
    });
    j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw badRequest(j.code || 'KORVO_REFUSED', `Korvo: ${j.message || resp.status}`);
  } catch (e) {
    if (e.status) throw e;
    throw badRequest('KORVO_UNREACHABLE', `Could not reach Korvo at ${base}: ${e.message}`);
  }
  const korvo = {
    ...(tenant.korvo || {}), companyCode: String(companyCode).toUpperCase(), companyId: j.companyId, companyName: j.companyName, baseUrl: base, linkedAt: new Date().toISOString(),
    ...(j.korvoApiKey ? { apiKeyEnc: encrypt(j.korvoApiKey) } : {}),
  };
  const settings = { ...(tenant.settings || {}), orderDms: 'korvo' };
  await query(`UPDATE tenants SET korvo=$2, settings=$3 WHERE id=$1`, [tenant.id, JSON.stringify(korvo), JSON.stringify(settings)]);
  return { korvo, connector };
}
