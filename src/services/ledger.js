import { badRequest, conflict } from '../lib/errors.js';

/**
 * The ONLY place wallet balances change. Must be called inside a transaction (db = tx client).
 * Locks the wallet row, applies the signed delta, writes one ledger row.
 *
 * opts.hold:   also move |points| into wallets.held (for redemption holds)
 * opts.release: move |points| out of held back to balance
 */
export async function post(db, { tenantId, participantId, type, points, refType = null, refId = null, note = null, createdBy = null, hold = false, release = false, settleHeld = 0 }) {
  if (!Number.isInteger(points)) throw badRequest('INVALID_POINTS', 'Points must be an integer');

  const { rows } = await db.query(`SELECT * FROM wallets WHERE participant_id = $1 FOR UPDATE`, [participantId]);
  let w = rows[0];
  if (!w) {
    const ins = await db.query(
      `INSERT INTO wallets (participant_id, tenant_id) VALUES ($1, $2) RETURNING *`,
      [participantId, tenantId],
    );
    w = ins.rows[0];
  }

  const newBalance = w.balance + points;
  if (newBalance < 0) throw conflict('INSUFFICIENT_POINTS', 'Not enough points', { balance: w.balance, requested: -points });

  let held = w.held;
  if (hold) held += Math.abs(points);
  if (release) held -= Math.abs(points);
  if (settleHeld) held -= settleHeld;
  if (held < 0) throw conflict('HELD_UNDERFLOW', 'Held points mismatch');

  const earned = points > 0 && ['EARN_SCAN', 'BONUS', 'ADJUST_CREDIT'].includes(type) ? points : 0;

  if (points !== 0) {
    try {
      await db.query(
        `INSERT INTO ledger_entries (tenant_id, participant_id, type, points, balance_after, ref_type, ref_id, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [tenantId, participantId, type, points, newBalance, refType, refId, note, createdBy],
      );
    } catch (e) {
      if (e.code === '23505') throw conflict('DUPLICATE_LEDGER_ENTRY', 'This transaction was already recorded');
      throw e;
    }
  }

  const upd = await db.query(
    `UPDATE wallets SET balance = $2, held = $3, lifetime_earned = lifetime_earned + $4,
            lifetime_redeemed = lifetime_redeemed + $5, updated_at = now()
     WHERE participant_id = $1 RETURNING *`,
    [participantId, newBalance, held, earned, settleHeld],
  );
  return upd.rows[0];
}

export async function getWallet(db, participantId) {
  const { rows } = await db.query(`SELECT balance, held, lifetime_earned, lifetime_redeemed FROM wallets WHERE participant_id = $1`, [participantId]);
  return rows[0] || { balance: 0, held: 0, lifetime_earned: 0, lifetime_redeemed: 0 };
}
