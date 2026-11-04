import { tx, query } from '../db/pool.js';
import { normalizeMobile } from '../lib/codes.js';
import { settingsOf, getTenant } from './tenants.js';
import * as ledger from './ledger.js';
import { emit } from './events.js';

const PARTY_TYPE_MAP = { dealers: 'DEALER', dealer: 'DEALER', distibutors: 'DISTRIBUTOR', distributors: 'DISTRIBUTOR', distributor: 'DISTRIBUTOR', subdealer: 'RETAILER', retailer: 'RETAILER' };
export const mapPartyType = (t) => {
  const k = String(t || '').toLowerCase();
  if (PARTY_TYPE_MAP[k]) return PARTY_TYPE_MAP[k];
  const up = String(t || '').toUpperCase();
  return ['DEALER', 'DISTRIBUTOR', 'RETAILER', 'MECHANIC', 'ELECTRICIAN', 'PLUMBER', 'CONTRACTOR', 'PAINTER', 'CARPENTER'].includes(up) ? up : 'DEALER';
};

/** Find the participant an invoice belongs to: external ref → GSTIN → mobile. */
export async function matchParticipant(db, tenantId, party = {}) {
  if (party.ref) {
    const { rows: [p] } = await db.query(`SELECT * FROM participants WHERE tenant_id=$1 AND external_ref=$2 LIMIT 1`, [tenantId, party.ref]);
    if (p) return p;
  }
  if (party.gstin) {
    const { rows: [p] } = await db.query(`SELECT * FROM participants WHERE tenant_id=$1 AND upper(gstin)=upper($2) LIMIT 1`, [tenantId, party.gstin]);
    if (p) return p;
  }
  const mobile = normalizeMobile(party.mobile);
  if (mobile) {
    const { rows: [p] } = await db.query(`SELECT * FROM participants WHERE tenant_id=$1 AND mobile=$2 LIMIT 1`, [tenantId, mobile]);
    if (p) return p;
  }
  return null;
}

/** Upsert dealer master from any accounting/DMS system. */
export async function upsertParties({ tenantId, connector, parties }) {
  const out = { created: 0, updated: 0, skipped: 0 };
  for (const p of parties) {
    await tx(async (db) => {
      const existing = await matchParticipant(db, tenantId, p);
      if (existing) {
        await db.query(
          `UPDATE participants SET external_ref=coalesce(external_ref,$2), name=coalesce($3,name), gstin=coalesce($4,gstin),
             city=coalesce($5,city), state=coalesce($6,state), pincode=coalesce($7,pincode) WHERE id=$1`,
          [existing.id, p.ref, p.name, p.gstin, p.city, p.state, p.pincode]);
        out.updated++;
        return;
      }
      const mobile = normalizeMobile(p.mobile);
      if (!mobile) { out.skipped++; return; } // participants log in by mobile; keep unmatched until a number is known
      const { rows: [np] } = await db.query(
        `INSERT INTO participants (tenant_id, type, name, mobile, gstin, city, state, pincode, external_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tenant_id, mobile) DO NOTHING RETURNING *`,
        [tenantId, mapPartyType(p.type), p.name, mobile, p.gstin, p.city, p.state, p.pincode, p.ref]);
      if (!np) { out.skipped++; return; }
      await db.query(`INSERT INTO wallets (participant_id, tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [np.id, tenantId]);
      await emit(db, tenantId, 'participant.created', { participantId: np.id, type: np.type, source: connector?.type || 'sync' });
      out.created++;
    });
  }
  return out;
}

async function matchProduct(db, tenantId, line) {
  if (line.sku) {
    const { rows: [p] } = await db.query(
      `SELECT * FROM products WHERE tenant_id=$1 AND (upper(sku)=upper($2) OR external_ref=$2) LIMIT 1`, [tenantId, line.sku]);
    if (p) return p;
  }
  if (line.name) {
    const { rows: [p] } = await db.query(`SELECT * FROM products WHERE tenant_id=$1 AND lower(name)=lower($2) LIMIT 1`, [tenantId, line.name]);
    if (p) return p;
  }
  return null;
}

function purchasePoints({ settings, participant, lines }) {
  if (!settings.purchaseEarnEnabled || !settings.purchaseEarnTypes.includes(participant.type)) return 0;
  let pts = 0;
  for (const l of lines) {
    if (l.product?.purchase_points_per_unit != null) pts += Number(l.product.purchase_points_per_unit) * Number(l.qty);
    else pts += (l.amountPaise / 100 / 1000) * settings.purchasePointsPer1000;
  }
  return Math.floor(pts);
}

/** Store documents idempotently, match them, award/reverse purchase points. */
export async function ingestDocuments({ connector, docs }) {
  const tenant = await getTenant(connector.tenant_id);
  const settings = settingsOf(tenant);
  const earn = connector.config?.earnPurchasePoints !== false;
  const summary = { received: docs.length, created: 0, duplicates: 0, processed: 0, unmatched: 0, pointsAwarded: 0, pointsReversed: 0, unmatchedIds: [] };

  for (const doc of docs) {
    await tx(async (db) => {
      const { rows: [inv] } = await db.query(
        `INSERT INTO invoices (tenant_id, connector_id, source, external_id, doc_type, against_external_id, invoice_date,
           party_ref, party_gstin, party_mobile, party_name, total_paise, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (tenant_id, connector_id, external_id, doc_type) DO NOTHING RETURNING *`,
        [tenant.id, connector.id, connector.type, doc.externalId, doc.docType, doc.againstExternalId || null, doc.date,
          doc.party.ref || null, doc.party.gstin || null, normalizeMobile(doc.party.mobile) || doc.party.mobile || null, doc.party.name || null,
          doc.totalPaise, { voucherNumber: doc.voucherNumber || null }]);
      if (!inv) { summary.duplicates++; return; }
      summary.created++;
      for (const l of doc.lines) {
        const product = await matchProduct(db, tenant.id, l);
        await db.query(`INSERT INTO invoice_lines (invoice_id, sku, item_name, product_id, qty, amount_paise) VALUES ($1,$2,$3,$4,$5,$6)`,
          [inv.id, l.sku || null, l.name || null, product?.id || null, l.qty, l.amountPaise]);
      }
      const participant = await matchParticipant(db, tenant.id, doc.party);
      if (!participant) { summary.unmatched++; summary.unmatchedIds.push(doc.externalId); return; }
      const r = await processInvoice(db, { tenant, settings, invoiceId: inv.id, participant, earn });
      summary.processed++; summary.pointsAwarded += Math.max(r.points, 0); summary.pointsReversed += Math.max(-r.points, 0);
    });
  }
  await query(`UPDATE connectors SET last_received_at=now() WHERE id=$1`, [connector.id]);
  return summary;
}

/** Award (invoice) or reverse (credit note) purchase points. Must run inside tx. */
export async function processInvoice(db, { tenant, settings, invoiceId, participant, earn = true }) {
  const { rows: [inv] } = await db.query(`SELECT * FROM invoices WHERE id=$1 FOR UPDATE`, [invoiceId]);
  if (inv.status === 'PROCESSED') return { points: Number(inv.base_points) };
  const { rows: lines } = await db.query(
    `SELECT l.*, row_to_json(p.*) AS product FROM invoice_lines l LEFT JOIN products p ON p.id=l.product_id WHERE l.invoice_id=$1`, [inv.id]);
  let points = earn ? purchasePoints({ settings, participant, lines: lines.map((l) => ({ ...l, amountPaise: Number(l.amount_paise) })) }) : 0;

  if (inv.doc_type === 'CREDIT_NOTE') {
    // never reverse more than the original invoice earned
    if (inv.against_external_id) {
      const { rows: [orig] } = await db.query(
        `SELECT base_points FROM invoices WHERE tenant_id=$1 AND connector_id=$2 AND external_id=$3 AND doc_type='INVOICE' AND status='PROCESSED'`,
        [inv.tenant_id, inv.connector_id, inv.against_external_id]);
      if (orig) points = Math.min(points, Number(orig.base_points));
    }
    points = -points;
  }
  if (points !== 0) {
    await ledger.post(db, {
      tenantId: inv.tenant_id, participantId: participant.id, type: points > 0 ? 'PURCHASE_EARN' : 'PURCHASE_REVERSAL', points,
      refType: 'invoice', refId: inv.id, note: `${inv.doc_type === 'CREDIT_NOTE' ? 'Return' : 'Purchase'} ${inv.raw?.voucherNumber || inv.external_id}`, allowNegative: true,
    });
  }
  await db.query(`UPDATE invoices SET status='PROCESSED', participant_id=$2, base_points=$3, processed_at=now() WHERE id=$1`, [inv.id, participant.id, points]);
  if (inv.doc_type === 'INVOICE') {
    await db.query(`UPDATE participants SET last_purchase_at = GREATEST(coalesce(last_purchase_at, '-infinity'), $2::date::timestamptz) WHERE id=$1`, [participant.id, inv.invoice_date]);
  }
  await emit(db, inv.tenant_id, 'purchase.recorded', { invoiceId: inv.id, participantId: participant.id, docType: inv.doc_type, totalPaise: Number(inv.total_paise), points });
  return { points };
}

/** Admin maps an unmatched invoice to a participant (and remembers the mapping for next time). */
export async function assignInvoice({ tenantId, invoiceId, participantId, remember = true }) {
  const tenant = await getTenant(tenantId);
  const settings = settingsOf(tenant);
  return tx(async (db) => {
    const { rows: [inv] } = await db.query(`SELECT i.*, c.config AS connector_config FROM invoices i LEFT JOIN connectors c ON c.id=i.connector_id WHERE i.id=$1 AND i.tenant_id=$2`, [invoiceId, tenantId]);
    if (!inv) return null;
    const { rows: [p] } = await db.query(`SELECT * FROM participants WHERE id=$1 AND tenant_id=$2`, [participantId, tenantId]);
    if (!p) return null;
    if (remember) {
      await db.query(`UPDATE participants SET external_ref=coalesce(external_ref,$2), gstin=coalesce(gstin,$3) WHERE id=$1`, [p.id, inv.party_ref, inv.party_gstin]);
    }
    const r = await processInvoice(db, { tenant, settings, invoiceId: inv.id, participant: p, earn: inv.connector_config?.earnPurchasePoints !== false });
    // Process this party's other unmatched invoices too
    let more = 0;
    if (remember && (inv.party_ref || inv.party_gstin)) {
      const { rows: others } = await db.query(
        `SELECT id FROM invoices WHERE tenant_id=$1 AND status='UNMATCHED' AND id<>$2 AND ((party_ref IS NOT NULL AND party_ref=$3) OR (party_gstin IS NOT NULL AND upper(party_gstin)=upper($4)))`,
        [tenantId, inv.id, inv.party_ref, inv.party_gstin]);
      for (const o of others) { await processInvoice(db, { tenant, settings, invoiceId: o.id, participant: p, earn: inv.connector_config?.earnPurchasePoints !== false }); more++; }
    }
    return { points: r.points, alsoProcessed: more };
  });
}
