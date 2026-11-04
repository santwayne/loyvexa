import { emit } from './events.js';

export async function flag(db, { tenantId, participantId, rule, details = {} }) {
  // De-duplicate: one open flag per participant+rule per day
  const { rows } = await db.query(
    `SELECT id FROM fraud_flags WHERE tenant_id=$1 AND participant_id IS NOT DISTINCT FROM $2 AND rule=$3
       AND status='OPEN' AND created_at > now() - interval '1 day' LIMIT 1`,
    [tenantId, participantId, rule],
  );
  if (rows[0]) return rows[0].id;
  const ins = await db.query(
    `INSERT INTO fraud_flags (tenant_id, participant_id, rule, details) VALUES ($1,$2,$3,$4) RETURNING id`,
    [tenantId, participantId, rule, details],
  );
  await emit(db, tenantId, 'fraud.flagged', { flagId: ins.rows[0].id, participantId, rule, details });
  return ins.rows[0].id;
}

/** Checks run BEFORE a scan is accepted. Returns { ok, result, message } */
export async function preScanChecks(db, { tenant, settings, participant, deviceId }) {
  if (participant.status !== 'ACTIVE') return { ok: false, result: 'BLOCKED', message: 'Account blocked. Contact the brand.' };
  if (participant.scan_blocked_until && new Date(participant.scan_blocked_until) > new Date()) {
    return { ok: false, result: 'BLOCKED', message: 'Scanning paused due to too many invalid scans. Try later.' };
  }

  const { rows: [counts] } = await db.query(
    `SELECT
       count(*) FILTER (WHERE result='SUCCESS' AND created_at > date_trunc('day', now())) AS today,
       count(*) FILTER (WHERE result='SUCCESS' AND created_at > now() - make_interval(secs => $2)) AS burst
     FROM scan_attempts WHERE participant_id = $1 AND created_at > now() - interval '1 day'`,
    [participant.id, settings.burstWindowSeconds],
  );
  if (Number(counts.today) >= settings.dailyScanLimit) {
    await flag(db, { tenantId: tenant.id, participantId: participant.id, rule: 'DAILY_LIMIT_REACHED', details: { limit: settings.dailyScanLimit } });
    return { ok: false, result: 'LIMIT', message: `Daily scan limit (${settings.dailyScanLimit}) reached.` };
  }
  if (Number(counts.burst) >= settings.burstScanLimit) {
    await flag(db, { tenantId: tenant.id, participantId: participant.id, rule: 'BURST_SCANNING', details: { scans: Number(counts.burst), windowSeconds: settings.burstWindowSeconds } });
    return { ok: false, result: 'LIMIT', message: 'Too many scans too fast. Please wait a minute.' };
  }

  if (deviceId) {
    const { rows: [d] } = await db.query(
      `SELECT count(DISTINCT participant_id) AS n FROM scan_attempts
        WHERE device_id = $1 AND tenant_id = $2 AND created_at > now() - interval '30 days'`,
      [deviceId, tenant.id],
    );
    if (Number(d.n) >= settings.maxParticipantsPerDevice) {
      const { rows: [mine] } = await db.query(
        `SELECT 1 FROM scan_attempts WHERE device_id=$1 AND participant_id=$2 LIMIT 1`, [deviceId, participant.id]);
      if (!mine) {
        await flag(db, { tenantId: tenant.id, participantId: participant.id, rule: 'SHARED_DEVICE', details: { deviceId, accountsOnDevice: Number(d.n) + 1 } });
      }
    }
  }
  return { ok: true };
}

/** After an invalid scan: pause scanning if too many invalid attempts in the last hour. */
export async function afterInvalidScan(db, { tenant, settings, participant }) {
  const { rows: [c] } = await db.query(
    `SELECT count(*) AS n FROM scan_attempts
      WHERE participant_id=$1 AND result IN ('INVALID','WRONG_BRAND','ALREADY_SCANNED','VOID')
        AND created_at > now() - interval '1 hour'`,
    [participant.id],
  );
  if (Number(c.n) >= settings.invalidScanLimitPerHour) {
    await db.query(
      `UPDATE participants SET scan_blocked_until = now() + make_interval(mins => $2) WHERE id = $1`,
      [participant.id, settings.invalidScanBlockMinutes],
    );
    await flag(db, { tenantId: tenant.id, participantId: participant.id, rule: 'REPEATED_INVALID_SCANS', details: { invalidLastHour: Number(c.n) } });
  }
}
