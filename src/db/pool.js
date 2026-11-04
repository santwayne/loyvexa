import pg from 'pg';
import { config } from '../config.js';

// bigint (int8) -> JS number; point values stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// DATE -> 'YYYY-MM-DD' string (avoid timezone shifts on mfg dates)
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 15 });

export const query = (text, params) => pool.query(text, params);

/** Run fn(client) inside a transaction. Rolls back on throw. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
