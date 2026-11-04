import { query, tx } from '../db/pool.js';
import { settingsOf } from './tenants.js';
import * as ledger from './ledger.js';
import { emit } from './events.js';

/**
 * FIFO points expiry (tenant setting pointsExpiryMonths, 0 = off).
 * Points earned before (asOf − N months) expire unless already used. Every debit
 * (cash-out, deduction, return, earlier expiry) consumes the OLDEST points first, so:
 *   expiring = earned before cutoff − everything consumed so far   (capped at the balance)
 * Idempotent per participant per day (ledger ref `expiry:<id>:<date>`).
 */
const EARN = `('EARN_SCAN','PURCHASE_EARN','SCHEME_BONUS','BONUS','ADJUST_CREDIT')`;
const addMonths = (d, m) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + m); return x; };

async function amounts(db, participantId, cutoff) {
  const { rows: [r] } = await db.query(`
    SELECT coalesce(sum(points) FILTER (WHERE type IN ${EARN} AND points > 0 AND created_at < $2), 0) AS earned_before,
           coalesce(-sum(points) FILTER (WHERE points < 0), 0) - coalesce(sum(points) FILTER (WHERE type='REDEEM_RELEASE'), 0) AS consumed
      FROM ledger_entries WHERE participant_id=$1`, [participantId, cutoff.toISOString()]);
  return { earnedBefore: Number(r.earned_before), consumed: Number(r.consumed) };
}

export async function runExpiry(asOf = new Date(), tenantId = null) {
  const { rows: tenants } = await query(`SELECT * FROM tenants WHERE status='ACTIVE' AND ($1::uuid IS NULL OR id=$1)`, [tenantId]);
  const out = { expired: 0, points: 0, reminders: 0 };
  const day = asOf.toISOString().slice(0, 10);
  for (const t of tenants) {
    const s = settingsOf(t);
    if (!(s.pointsExpiryMonths > 0)) continue;
    const cutoff = addMonths(asOf, -s.pointsExpiryMonths);
    const soonCutoff = new Date(cutoff.getTime() + s.expiryReminderDays * 86400000);
    const { rows: people } = await query(`SELECT p.id, p.expiry_reminded_at, w.balance FROM participants p JOIN wallets w ON w.participant_id=p.id WHERE p.tenant_id=$1 AND w.balance > 0`, [t.id]);
    for (const p of people) {
      await tx(async (db) => {
        const a = await amounts(db, p.id, cutoff);
        const exp = Math.min(Number(p.balance), a.earnedBefore - a.consumed);
        if (exp > 0) {
          try {
            await ledger.post(db, { tenantId: t.id, participantId: p.id, type: 'EXPIRE', points: -exp, refType: 'expiry', refId: `${p.id}:${day}`, note: `Expired (older than ${s.pointsExpiryMonths} months)` });
            await emit(db, t.id, 'points.expired', { participantId: p.id, points: exp });
            out.expired++; out.points += exp;
          } catch (e) { if (e.code !== 'DUPLICATE_LEDGER_ENTRY') throw e; }
          return;
        }
        const soon = await amounts(db, p.id, soonCutoff);
        const willExpire = Math.min(Number(p.balance), soon.earnedBefore - soon.consumed);
        const reminded = p.expiry_reminded_at && (asOf - new Date(p.expiry_reminded_at)) < 7 * 86400000;
        if (willExpire > 0 && !reminded) {
          await db.query(`UPDATE participants SET expiry_reminded_at=$2 WHERE id=$1`, [p.id, asOf.toISOString()]);
          await emit(db, t.id, 'points.expiring', { participantId: p.id, points: willExpire, withinDays: s.expiryReminderDays });
          out.reminders++;
        }
      });
    }
  }
  return out;
}
