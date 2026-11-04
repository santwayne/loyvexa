/**
 * Background worker (run as a separate process: `npm run worker`).
 *  - Delivers outbox events (WhatsApp notifications now; WayneRing call lists / Royal callbacks plug in here later)
 *  - Auto-settles slab schemes once their grace period is over
 */
import { pool, query } from './db/pool.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { deliverEvent } from './services/notifications.js';
import { autoSettleDue } from './services/schemes.js';

const MAX_ATTEMPTS = 5;

export async function processEventsOnce(batch = 100) {
  const client = await pool.connect();
  let n = 0;
  try {
    await client.query('BEGIN');
    // SKIP LOCKED lets several workers run side by side safely
    const { rows } = await client.query(
      `SELECT * FROM events WHERE delivered_at IS NULL AND attempts < $1 ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED`, [MAX_ATTEMPTS, batch]);
    for (const e of rows) {
      try {
        const result = await deliverEvent(e);
        await client.query(`UPDATE events SET delivered_at=now(), attempts=attempts+1, last_error=$2 WHERE id=$1`, [e.id, result === 'sent-text' || result === 'sent-template' ? null : result]);
      } catch (err) {
        await client.query(`UPDATE events SET attempts=attempts+1, last_error=$2 WHERE id=$1`, [e.id, err.message.slice(0, 500)]);
      }
      n++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return n;
}

export async function tick() {
  const settled = await autoSettleDue();
  let delivered = 0; let k;
  do { k = await processEventsOnce(); delivered += k; } while (k === 100);
  return { settled, delivered };
}

if (process.argv[1]?.endsWith('worker.js')) {
  await migrate();
  console.log(`worker running every ${config.workerIntervalMs}ms`);
  const loop = async () => {
    try {
      const r = await tick();
      if (r.delivered || r.settled.length) console.log(new Date().toISOString(), `delivered=${r.delivered} settled=${r.settled.length}`);
    } catch (e) { console.error('worker error', e); }
    setTimeout(loop, config.workerIntervalMs);
  };
  loop();
  process.on('SIGTERM', () => query('SELECT 1').finally(() => process.exit(0)));
}
