/**
 * Accounting / DMS adapters. Every source is normalised into ONE canonical shape,
 * so schemes and points never care which software the brand uses.
 *
 * Canonical document:
 *   { externalId, docType: 'INVOICE'|'CREDIT_NOTE', againstExternalId?, date: 'YYYY-MM-DD',
 *     party: { ref?, gstin?, mobile?, name? },
 *     lines: [{ sku?, name?, qty, amountPaise }],     // amountPaise = taxable value (pre-GST)
 *     totalPaise }
 *
 * Canonical party (dealer master):
 *   { ref, name?, mobile?, gstin?, type?, city?, state?, pincode? }
 */
import { XMLParser } from 'fast-xml-parser';
import { badRequest } from '../lib/errors.js';

const toPaise = (rupees) => Math.round(Math.abs(Number(String(rupees ?? 0).replace(/[^0-9.-]/g, '')) || 0) * 100);
const num = (v) => Math.abs(Number(String(v ?? 0).replace(/[^0-9.-]/g, '')) || 0);
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const txt = (v) => (v == null ? undefined : typeof v === 'object' ? (v['#text'] ?? undefined) : String(v).trim() || undefined);

export function isoDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;           // Tally 20261101
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);                                      // 01-11-2026 (Indian)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const m2 = s.match(/^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*[- ,]+(\d{2,4})$/);                         // 1-Nov-26
  if (m2 && MON[m2[2].toLowerCase()]) {
    const y = m2[3].length === 2 ? `20${m2[3]}` : m2[3];
    return `${y}-${String(MON[m2[2].toLowerCase()]).padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const CREDIT_WORDS = /credit\s*note|sales\s*return|return|cancel/i;
const finalize = (doc) => {
  doc.lines = doc.lines.filter((l) => l.qty || l.amountPaise);
  if (!doc.totalPaise) doc.totalPaise = doc.lines.reduce((s, l) => s + l.amountPaise, 0);
  if (!doc.externalId) throw badRequest('MISSING_EXTERNAL_ID', 'Every document needs an invoice/voucher number or id');
  if (!doc.date) throw badRequest('MISSING_DATE', `Document ${doc.externalId} has no valid date`);
  return doc;
};

// ---------- GENERIC (any software that can POST JSON) ----------
export function generic(body) {
  const docs = Array.isArray(body) ? body : body?.documents || body?.invoices || (body ? [body] : []);
  return docs.map((d) => finalize({
    externalId: txt(d.externalId ?? d.invoiceNumber ?? d.id),
    docType: String(d.docType || d.type || 'INVOICE').toUpperCase().includes('CREDIT') ? 'CREDIT_NOTE' : 'INVOICE',
    againstExternalId: txt(d.againstExternalId ?? d.originalInvoice),
    date: isoDate(d.date ?? d.invoiceDate),
    party: { ref: txt(d.party?.ref ?? d.partyRef ?? d.customerId), gstin: txt(d.party?.gstin ?? d.gstin), mobile: txt(d.party?.mobile ?? d.mobile), name: txt(d.party?.name ?? d.partyName ?? d.customerName) },
    lines: arr(d.lines ?? d.items).map((l) => ({
      sku: txt(l.sku ?? l.itemCode ?? l.productCode), name: txt(l.name ?? l.itemName),
      qty: num(l.qty ?? l.quantity), amountPaise: l.amountPaise != null ? Math.abs(Math.round(l.amountPaise)) : toPaise(l.amount ?? l.taxableValue ?? l.total),
    })),
    totalPaise: d.totalPaise != null ? Math.abs(Math.round(d.totalPaise)) : d.total != null ? toPaise(d.total) : 0,
  }));
}

// ---------- TALLY ----------
// (a) Line-level JSON pushed by a Tally TDL/connector (same shape Royal's Tally sync already uses)
// (b) Tally XML export (ENVELOPE ... VOUCHER)
export function tally(body, { rawText } = {}) {
  if (rawText && rawText.trim().startsWith('<')) return tallyXml(rawText);
  const rows = Array.isArray(body) ? body : body?.data || body?.entries || body?.sales || (body ? [body] : []);
  if (rows.length && rows[0]?.vchguid !== undefined) {
    const byVch = new Map();
    for (const r of rows) {
      const key = txt(r.vchguid);
      if (!byVch.has(key)) {
        byVch.set(key, {
          externalId: key, docType: CREDIT_WORDS.test(r.vchtype || '') ? 'CREDIT_NOTE' : 'INVOICE',
          voucherNumber: txt(r.vchnumber), date: isoDate(r.vchdate),
          party: { ref: txt(r.ledgerguid), name: txt(r.ledgername), gstin: txt(r.gstin ?? r.partygstin), mobile: txt(r.mobile ?? r.ledgermobile) },
          lines: [], totalPaise: 0,
        });
      }
      byVch.get(key).lines.push({ sku: txt(r.itemsku ?? r.itemguid), name: txt(r.itemname), qty: num(r.quantity), amountPaise: toPaise(r.amount) });
    }
    return [...byVch.values()].map(finalize);
  }
  return generic(body);
}

function tallyXml(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, isArray: (n) => ['VOUCHER', 'TALLYMESSAGE', 'ALLINVENTORYENTRIES.LIST', 'INVENTORYENTRIES.LIST'].includes(n) });
  const j = parser.parse(xml);
  const vouchers = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (k === 'VOUCHER') vouchers.push(...arr(v));
      else if (typeof v === 'object') arr(v).forEach(walk);
    }
  };
  walk(j);
  if (!vouchers.length) throw badRequest('NO_VOUCHERS', 'No <VOUCHER> elements found in Tally XML');
  return vouchers.map((v) => {
    const type = txt(v.VOUCHERTYPENAME) || v['@VCHTYPE'] || '';
    const inv = [...arr(v['ALLINVENTORYENTRIES.LIST']), ...arr(v['INVENTORYENTRIES.LIST'])];
    return finalize({
      externalId: txt(v.GUID) || txt(v.VOUCHERNUMBER) || v['@REMOTEID'],
      voucherNumber: txt(v.VOUCHERNUMBER),
      docType: CREDIT_WORDS.test(type) ? 'CREDIT_NOTE' : 'INVOICE',
      date: isoDate(txt(v.DATE)),
      party: { name: txt(v.PARTYLEDGERNAME) || txt(v.PARTYNAME), gstin: txt(v.PARTYGSTIN) || txt(v.BASICBUYERGSTIN), ref: txt(v.PARTYLEDGERNAME) },
      lines: inv.map((e) => ({ sku: txt(e.STOCKITEMNAME), name: txt(e.STOCKITEMNAME), qty: num(String(txt(e.BILLEDQTY) || txt(e.ACTUALQTY) || '0').split(' ').filter(Boolean)[0]), amountPaise: toPaise(txt(e.AMOUNT)) })),
      totalPaise: 0,
    });
  });
}

// ---------- ZOHO BOOKS (webhook payload of invoice / credit note) ----------
export function zohoBooks(body) {
  const items = body?.invoices || body?.creditnotes || [body?.invoice || body?.creditnote || body].filter(Boolean);
  return arr(items).map((d) => {
    const isCN = !!(body?.creditnote || body?.creditnotes || d.creditnote_id);
    return finalize({
      externalId: txt(d.invoice_id ?? d.creditnote_id ?? d.invoice_number ?? d.creditnote_number),
      voucherNumber: txt(d.invoice_number ?? d.creditnote_number),
      docType: isCN ? 'CREDIT_NOTE' : 'INVOICE',
      againstExternalId: txt(d.invoice_id_ref ?? d.reference_invoice_id),
      date: isoDate(d.date),
      party: { ref: txt(d.customer_id), name: txt(d.customer_name), gstin: txt(d.gst_no), mobile: txt(d.contact_persons_details?.[0]?.mobile ?? d.mobile) },
      lines: arr(d.line_items).map((l) => ({ sku: txt(l.sku ?? l.item_id), name: txt(l.name), qty: num(l.quantity), amountPaise: toPaise(l.item_total ?? (num(l.rate) * num(l.quantity))) })),
      totalPaise: toPaise(d.sub_total ?? d.total),
    });
  });
}

// ---------- ROYAL (DMS) order webhook ----------
// Earns on the status chosen in connector.config.earnOn (default 'delivered').
// cancelled / returned after earning -> credit note that reverses the points.
export function royal(body, { config = {} } = {}) {
  const events = Array.isArray(body) ? body : [body];
  const earnOn = config.earnOn || 'delivered';
  const out = [];
  for (const e of events) {
    const o = e.order || e;
    const status = String(e.event || o.status || '').replace(/^order\./, '').toLowerCase();
    const base = {
      externalId: txt(o.orderNumber ?? o._id),
      date: isoDate(o.deliveryDate && status === 'delivered' ? o.deliveryDate : o.orderDate ?? o.createdAt),
      party: {
        ref: txt(o.dealerId?._id ?? o.dealerId ?? o.customerId?._id ?? o.customerId),
        name: txt(o.dealerName ?? o.customerName), mobile: txt(o.customerMobile), gstin: txt(o.buyerGstin ?? o.customerGstin),
      },
      lines: arr(o.items).map((l) => ({ sku: txt(l.productCode ?? l.productId?._id ?? l.productId), name: txt(l.productName), qty: num(l.quantity), amountPaise: toPaise(l.taxableValue ?? l.totalPrice) })),
      totalPaise: toPaise(o.taxableValueTotal ?? o.totalAmount),
    };
    if (status === earnOn || (earnOn === 'approved' && status === 'approved')) out.push(finalize({ ...base, docType: 'INVOICE' }));
    else if (['cancelled', 'returned'].includes(status)) out.push(finalize({ ...base, docType: 'CREDIT_NOTE', againstExternalId: base.externalId }));
  }
  return out;
}

// ---------- CSV (Busy, Marg, Vyapar, Excel exports — anything) ----------
// One row per invoice line. Column names are configurable per connector (config.columns).
export const DEFAULT_CSV_COLUMNS = {
  externalId: ['invoice_no', 'invoice number', 'voucher no', 'vch no', 'bill no', 'externalid'],
  docType: ['doc_type', 'voucher type', 'vch type', 'type'],
  date: ['date', 'invoice date', 'bill date', 'vch date'],
  partyRef: ['party_code', 'party code', 'customer code', 'account code', 'party_ref'],
  partyName: ['party', 'party name', 'customer', 'customer name', 'account name'],
  gstin: ['gstin', 'gst no', 'party gstin', 'gstin/uin'],
  mobile: ['mobile', 'phone', 'party mobile'],
  sku: ['sku', 'item code', 'product code', 'item_code'],
  itemName: ['item', 'item name', 'product', 'product name'],
  qty: ['qty', 'quantity', 'billed qty'],
  amount: ['amount', 'taxable value', 'taxable amount', 'net amount', 'value'],
};

export function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

export function csv(rawText, { config = {} } = {}) {
  const rows = parseCsv(String(rawText || ''));
  if (rows.length < 2) throw badRequest('EMPTY_CSV', 'CSV needs a header row and at least one data row');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const cols = { ...DEFAULT_CSV_COLUMNS, ...(config.columns || {}) };
  const idx = Object.fromEntries(Object.entries(cols).map(([k, names]) => [k, header.findIndex((h) => arr(names).map((n) => n.toLowerCase()).includes(h))]));
  if (idx.externalId < 0 || idx.date < 0 || idx.amount < 0) throw badRequest('CSV_COLUMNS', `CSV must have invoice number, date and amount columns. Found: ${header.join(', ')}`);
  const get = (r, k) => (idx[k] >= 0 ? r[idx[k]]?.trim() : undefined) || undefined;
  const docs = new Map();
  for (const r of rows.slice(1)) {
    const docType = CREDIT_WORDS.test(get(r, 'docType') || '') ? 'CREDIT_NOTE' : 'INVOICE';
    const key = `${docType}:${get(r, 'externalId')}`;
    if (!docs.has(key)) docs.set(key, { externalId: get(r, 'externalId'), docType, date: isoDate(get(r, 'date')), party: { ref: get(r, 'partyRef'), name: get(r, 'partyName'), gstin: get(r, 'gstin'), mobile: get(r, 'mobile') }, lines: [], totalPaise: 0 });
    docs.get(key).lines.push({ sku: get(r, 'sku'), name: get(r, 'itemName'), qty: num(get(r, 'qty')), amountPaise: toPaise(get(r, 'amount')) });
  }
  return [...docs.values()].map(finalize);
}

export function parseDocuments(type, { body, rawText, config }) {
  switch (type) {
    case 'TALLY': return tally(body, { rawText });
    case 'ZOHO_BOOKS': return zohoBooks(body);
    case 'ROYAL': return royal(body, { config });
    case 'CSV': case 'BUSY': case 'MARG': return rawText && !rawText.trim().startsWith('{') && !rawText.trim().startsWith('[') ? csv(rawText, { config }) : generic(body);
    default: return generic(body);
  }
}

/** Dealer master sync — same canonical shape from every source. */
export function parseParties(type, body) {
  const rows = Array.isArray(body) ? body : body?.parties || body?.dealers || body?.data || (body ? [body] : []);
  return rows.map((p) => ({
    ref: txt(p.ref ?? p.externalRef ?? p.ledgerguid ?? p.guid ?? p._id ?? p.customer_id ?? p.code),
    name: txt(p.name ?? p.ledgername ?? p.customer_name ?? p.contact_name),
    mobile: txt(p.mobile ?? p.phone ?? p.ledgermobile),
    gstin: txt(p.gstin ?? p.gst_no ?? p.partygstin),
    type: txt(p.type ?? p.role),
    city: txt(p.city ?? p.address?.city), state: txt(p.state ?? p.address?.state), pincode: txt(p.pincode ?? p.address?.pincode),
  })).filter((p) => p.ref);
}
