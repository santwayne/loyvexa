import { tx, query } from '../db/pool.js';
import { settingsOf } from './tenants.js';
import * as ledger from './ledger.js';
import { emit } from './events.js';
import { getProvider } from './payouts/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { config } from '../config.js';

const UPI_RE = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,64}$/;
export const isValidUpi = (v) => UPI_RE.test(String(v || ''));

/** Participant asks to cash out. Points move from balance to held immediately. */
export async function requestRedemption({ tenant, participantId, points }) {
  const s = settingsOf(tenant);
  if (!Number.isInteger(points) || points < s.minRedeemPoints) throw badRequest('BELOW_MINIMUM', `Minimum redemption is ${s.minRedeemPoints} points`);

  const redemption = await tx(async (db) => {
    const { rows: [p] } = await db.query(`SELECT * FROM participants WHERE id=$1 FOR UPDATE`, [participantId]);
    if (p.status !== 'ACTIVE') throw conflict('BLOCKED', 'Account blocked');
    if (!isValidUpi(p.upi_id)) throw badRequest('UPI_REQUIRED', 'Add a valid UPI ID first');

    const { rows: [today] } = await db.query(
      `SELECT coalesce(sum(points),0) AS n FROM redemptions WHERE participant_id=$1 AND status <> 'REJECTED' AND status <> 'FAILED'
         AND created_at > date_trunc('day', now())`, [participantId]);
    if (Number(today.n) + points > s.maxRedeemPointsPerDay) throw conflict('DAILY_REDEEM_LIMIT', `Daily redemption limit is ${s.maxRedeemPointsPerDay} points`);

    const { rows: [r] } = await db.query(
      `INSERT INTO redemptions (tenant_id, participant_id, points, amount_paise, upi_id, provider)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenant.id, participantId, points, points * s.pointValuePaise, p.upi_id, config.payoutProvider]);
    await ledger.post(db, { tenantId: tenant.id, participantId, type: 'REDEEM_HOLD', points: -points, refType: 'redemption', refId: r.id, note: `UPI ${p.upi_id}`, hold: true });
    await emit(db, tenant.id, 'redemption.requested', { redemptionId: r.id, participantId, points, amountPaise: r.amount_paise });
    return r;
  });

  if (s.autoApproveRedeemUptoPoints > 0 && points <= s.autoApproveRedeemUptoPoints) {
    return processRedemption({ tenantId: tenant.id, redemptionId: redemption.id, approvedBy: null });
  }
  return redemption;
}

/** Admin approves (or auto-approve). Sends money via provider. */
export async function processRedemption({ tenantId, redemptionId, approvedBy }) {
  // Claim it first so a double-click can't pay twice
  const { rows: [r] } = await query(
    `UPDATE redemptions SET status='PROCESSING', approved_by=$3, updated_at=now()
      WHERE id=$1 AND tenant_id=$2 AND status='REQUESTED' RETURNING *`, [redemptionId, tenantId, approvedBy]);
  if (!r) {
    const { rows: [ex] } = await query(`SELECT status FROM redemptions WHERE id=$1 AND tenant_id=$2`, [redemptionId, tenantId]);
    if (!ex) throw notFound('Redemption');
    throw conflict('INVALID_STATE', `Redemption is already ${ex.status}`);
  }
  const { rows: [p] } = await query(`SELECT name, mobile FROM participants WHERE id=$1`, [r.participant_id]);
  const provider = getProvider(r.provider || undefined);
  let out;
  try {
    out = await provider.pay({ redemptionId: r.id, amountPaise: r.amount_paise, upiId: r.upi_id, name: p.name, mobile: p.mobile });
  } catch (e) {
    out = { status: 'PROCESSING', failureReason: `Provider error, awaiting confirmation: ${e.message}` }; // never auto-refund on unknown outcome
  }
  if (out.providerRef) await query(`UPDATE redemptions SET provider_ref=$2, updated_at=now() WHERE id=$1`, [r.id, out.providerRef]);
  if (out.status === 'PAID' || out.status === 'FAILED') return settleRedemption({ redemptionId: r.id, status: out.status, providerRef: out.providerRef, failureReason: out.failureReason });
  const { rows: [cur] } = await query(`SELECT * FROM redemptions WHERE id=$1`, [r.id]);
  return cur;
}

/** Final state from provider (sync result or webhook). Idempotent. */
export async function settleRedemption({ redemptionId, status, providerRef, failureReason }) {
  return tx(async (db) => {
    const { rows: [r] } = await db.query(`SELECT * FROM redemptions WHERE id=$1 FOR UPDATE`, [redemptionId]);
    if (!r) throw notFound('Redemption');
    if (['PAID', 'FAILED', 'REJECTED'].includes(r.status)) return r; // already final
    if (status === 'PAID') {
      await ledger.post(db, { tenantId: r.tenant_id, participantId: r.participant_id, type: 'REDEEM_HOLD', points: 0, settleHeld: r.points });
      const { rows: [u] } = await db.query(
        `UPDATE redemptions SET status='PAID', provider_ref=coalesce($2, provider_ref), updated_at=now() WHERE id=$1 RETURNING *`, [r.id, providerRef]);
      await emit(db, r.tenant_id, 'redemption.paid', { redemptionId: r.id, participantId: r.participant_id, amountPaise: r.amount_paise });
      return u;
    }
    await ledger.post(db, { tenantId: r.tenant_id, participantId: r.participant_id, type: 'REDEEM_RELEASE', points: r.points, refType: 'redemption', refId: r.id, note: `Refund: ${failureReason || 'payout failed'}`, release: true });
    const { rows: [u] } = await db.query(
      `UPDATE redemptions SET status='FAILED', failure_reason=$2, provider_ref=coalesce($3, provider_ref), updated_at=now() WHERE id=$1 RETURNING *`,
      [r.id, failureReason || 'Payout failed', providerRef]);
    await emit(db, r.tenant_id, 'redemption.failed', { redemptionId: r.id, participantId: r.participant_id, reason: failureReason });
    return u;
  });
}

export async function rejectRedemption({ tenantId, redemptionId, adminId, reason }) {
  return tx(async (db) => {
    const { rows: [r] } = await db.query(`SELECT * FROM redemptions WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [redemptionId, tenantId]);
    if (!r) throw notFound('Redemption');
    if (r.status !== 'REQUESTED') throw conflict('INVALID_STATE', `Redemption is already ${r.status}`);
    await ledger.post(db, { tenantId, participantId: r.participant_id, type: 'REDEEM_RELEASE', points: r.points, refType: 'redemption', refId: r.id, note: `Rejected: ${reason || ''}`.trim(), createdBy: adminId, release: true });
    const { rows: [u] } = await db.query(
      `UPDATE redemptions SET status='REJECTED', failure_reason=$2, approved_by=$3, updated_at=now() WHERE id=$1 RETURNING *`, [r.id, reason || 'Rejected', adminId]);
    return u;
  });
}
