/**
 * Outbox events. Phase 2/3 workers read undelivered rows and fan out to
 * WhatsApp (Regulars engine), WayneRing AI calls, and Royal webhooks.
 *
 * Event types emitted in Phase 1:
 *   participant.created, scan.succeeded, redemption.requested,
 *   redemption.paid, redemption.failed, fraud.flagged, points.adjusted
 */
export async function emit(db, tenantId, type, payload) {
  await db.query(`INSERT INTO events (tenant_id, type, payload) VALUES ($1, $2, $3)`, [tenantId, type, payload]);
}
