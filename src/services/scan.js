import { tx } from '../db/pool.js';
import { extractCode } from '../lib/codes.js';
import { settingsOf } from './tenants.js';
import { preScanChecks, afterInvalidScan, flag } from './fraud.js';
import * as ledger from './ledger.js';
import { emit } from './events.js';

const MESSAGES = {
  INVALID: 'This code is not valid. The product may not be genuine.',
  WRONG_BRAND: 'This code belongs to a different brand.',
  ALREADY_SCANNED: 'This code has already been used.',
  VOID: 'This code has been cancelled by the brand.',
  INACTIVE_PRODUCT: 'This product is not part of the rewards programme right now.',
};

/**
 * Scan-to-earn. Serialised per participant (row lock) so limits can't be raced,
 * and the code is claimed with a conditional UPDATE so it can only ever pay once.
 */
export async function scan({ tenant, participantId, input, lat = null, lng = null, deviceId = null, ip = null }) {
  const settings = settingsOf(tenant);
  const code = extractCode(input);

  return tx(async (db) => {
    const { rows: [participant] } = await db.query(`SELECT * FROM participants WHERE id = $1 FOR UPDATE`, [participantId]);

    const record = (result) => db.query(
      `INSERT INTO scan_attempts (tenant_id, participant_id, code, result, lat, lng, device_id, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenant.id, participantId, code || String(input || '').slice(0, 64), result, lat, lng, deviceId, ip],
    );
    const fail = async (result, message) => {
      await record(result);
      if (['INVALID', 'WRONG_BRAND', 'ALREADY_SCANNED', 'VOID'].includes(result)) await afterInvalidScan(db, { tenant, settings, participant });
      return { ok: false, result, message: message || MESSAGES[result] };
    };

    const pre = await preScanChecks(db, { tenant, settings, participant, deviceId });
    if (!pre.ok) { await record(pre.result); return pre; }

    if (!code) return fail('INVALID');

    const { rows: [qr] } = await db.query(
      `SELECT q.*, p.name AS product_name, p.sku, p.points AS default_points, p.points_by_type, p.active AS product_active, b.status AS batch_status
         FROM qr_codes q JOIN products p ON p.id = q.product_id JOIN qr_batches b ON b.id = q.batch_id
        WHERE q.code = $1`,
      [code],
    );
    if (!qr) return fail('INVALID');
    if (qr.tenant_id !== tenant.id) return fail('WRONG_BRAND');
    if (qr.status === 'VOID' || qr.batch_status === 'VOID') return fail('VOID');
    if (!qr.product_active) return fail('INACTIVE_PRODUCT');

    // Atomic claim — only one transaction can flip UNUSED -> SCANNED
    const claim = await db.query(
      `UPDATE qr_codes SET status='SCANNED', scanned_by=$2, scanned_at=now(), scan_lat=$3, scan_lng=$4
        WHERE id=$1 AND status='UNUSED' RETURNING id`,
      [qr.id, participantId, lat, lng],
    );
    if (!claim.rowCount) {
      // Re-scanning your own code (camera fires twice) is harmless — don't count it towards lockout.
      if (qr.scanned_by === participantId) {
        await record('DUPLICATE_SELF');
        return { ok: false, result: 'ALREADY_SCANNED', message: 'You already earned points for this code.' };
      }
      if (qr.scanned_by && qr.scanned_by !== participantId) {
        await flag(db, { tenantId: tenant.id, participantId, rule: 'SCANNED_SOMEONE_ELSES_CODE', details: { code, firstScannedBy: qr.scanned_by } });
      }
      return fail('ALREADY_SCANNED');
    }

    const points = Number(qr.points_by_type?.[participant.type] ?? qr.default_points);
    const wallet = await ledger.post(db, {
      tenantId: tenant.id, participantId, type: 'EARN_SCAN', points,
      refType: 'qr_code', refId: String(qr.id), note: `${qr.product_name} (${qr.sku})`,
    });
    await db.query(`UPDATE participants SET last_scan_at = now() WHERE id = $1`, [participantId]);
    await record('SUCCESS');
    await emit(db, tenant.id, 'scan.succeeded', { participantId, code, productId: qr.product_id, sku: qr.sku, points, lat, lng });

    return {
      ok: true, result: 'SUCCESS', points,
      product: { name: qr.product_name, sku: qr.sku },
      wallet: { balance: wallet.balance, held: wallet.held, lifetimeEarned: wallet.lifetime_earned },
      message: `+${points} points for ${qr.product_name}`,
    };
  });
}
