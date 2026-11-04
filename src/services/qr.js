import { tx, query } from '../db/pool.js';
import { randomCode, formatCode } from '../lib/codes.js';
import { config } from '../config.js';
import { badRequest, notFound } from '../lib/errors.js';

export const MAX_BATCH = 100000;
export const codeUrl = (code) => `${config.publicBaseUrl}/q/${code}`;

export async function createBatch({ tenantId, productId, quantity, label, mfgDate, createdBy }) {
  if (quantity < 1 || quantity > MAX_BATCH) throw badRequest('INVALID_QUANTITY', `Quantity must be 1–${MAX_BATCH}`);
  return tx(async (db) => {
    const { rows: [product] } = await db.query(`SELECT id FROM products WHERE id=$1 AND tenant_id=$2`, [productId, tenantId]);
    if (!product) throw notFound('Product');
    const { rows: [batch] } = await db.query(
      `INSERT INTO qr_batches (tenant_id, product_id, label, quantity, mfg_date, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenantId, productId, label || null, quantity, mfgDate || null, createdBy],
    );
    // Insert in chunks using unnest; ON CONFLICT skips the (astronomically rare) duplicate, then we top up.
    let serial = 1;
    while (serial <= quantity) {
      const n = Math.min(5000, quantity - serial + 1);
      const codes = Array.from({ length: n }, () => randomCode());
      const serials = Array.from({ length: n }, (_, i) => serial + i);
      const r = await db.query(
        `INSERT INTO qr_codes (tenant_id, batch_id, product_id, code, serial_no)
         SELECT $1, $2, $3, c, s FROM unnest($4::text[], $5::int[]) AS t(c, s)
         ON CONFLICT (code) DO NOTHING`,
        [tenantId, batch.id, productId, codes, serials],
      );
      if (r.rowCount === n) { serial += n; continue; }
      // retry the missing serials individually
      const { rows } = await db.query(`SELECT serial_no FROM qr_codes WHERE batch_id=$1 AND serial_no = ANY($2::int[])`, [batch.id, serials]);
      const have = new Set(rows.map((x) => x.serial_no));
      for (const s of serials) {
        while (!have.has(s)) {
          const ok = await db.query(
            `INSERT INTO qr_codes (tenant_id, batch_id, product_id, code, serial_no) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (code) DO NOTHING`,
            [tenantId, batch.id, productId, randomCode(), s]);
          if (ok.rowCount) have.add(s);
        }
      }
      serial += n;
    }
    return batch;
  });
}

/** Streams a CSV a label printer / packaging vendor can use for variable-data printing. */
export async function streamBatchCsv(res, { tenantId, batchId }) {
  const { rows: [batch] } = await query(
    `SELECT b.*, p.sku, p.name AS product_name FROM qr_batches b JOIN products p ON p.id=b.product_id WHERE b.id=$1 AND b.tenant_id=$2`,
    [batchId, tenantId]);
  if (!batch) throw notFound('Batch');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="batch-${batch.sku}-${batch.id.slice(0, 8)}.csv"`);
  res.write('serial_no,code,code_printed,qr_url,sku,product,mfg_date\n');
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  let last = 0;
  for (;;) {
    const { rows } = await query(
      `SELECT serial_no, code FROM qr_codes WHERE batch_id=$1 AND serial_no > $2 ORDER BY serial_no LIMIT 5000`, [batchId, last]);
    if (!rows.length) break;
    res.write(rows.map((r) => [r.serial_no, r.code, formatCode(r.code), codeUrl(r.code), batch.sku, batch.product_name, batch.mfg_date || '']
      .map(esc).join(',')).join('\n') + '\n');
    last = rows[rows.length - 1].serial_no;
  }
  res.end();
}

/** Public authenticity check — anyone can scan the QR with a normal camera. */
export async function verify({ code, ip, userAgent }) {
  const { rows: [q] } = await query(
    `SELECT q.*, p.name AS product_name, p.sku, p.category, b.mfg_date, b.status AS batch_status,
            t.name AS brand, t.slug AS brand_slug, t.brand_color, t.logo_url
       FROM qr_codes q JOIN products p ON p.id=q.product_id JOIN qr_batches b ON b.id=q.batch_id JOIN tenants t ON t.id=q.tenant_id
      WHERE q.code = $1`, [code]);
  let result = 'NOT_FOUND';
  if (q) result = (q.status === 'VOID' || q.batch_status === 'VOID') ? 'VOID' : q.status === 'SCANNED' ? 'ALREADY_SCANNED' : 'GENUINE';
  await query(`INSERT INTO verify_checks (tenant_id, code, result, ip, user_agent) VALUES ($1,$2,$3,$4,$5)`,
    [q?.tenant_id || null, code, result, ip, userAgent?.slice(0, 200)]);
  if (q) await query(`UPDATE qr_codes SET verify_count = verify_count + 1 WHERE id = $1`, [q.id]);
  if (!q) return { result, genuine: false };
  return {
    result,
    genuine: result === 'GENUINE' || result === 'ALREADY_SCANNED',
    brand: { name: q.brand, slug: q.brand_slug, color: q.brand_color, logoUrl: q.logo_url },
    product: { name: q.product_name, sku: q.sku, category: q.category },
    mfgDate: q.mfg_date,
    serialNo: q.serial_no,
    rewardClaimed: q.status === 'SCANNED',
    scannedAt: q.scanned_at,
  };
}
