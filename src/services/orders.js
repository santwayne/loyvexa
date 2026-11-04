import crypto from 'node:crypto';
import { query, tx, pool } from '../db/pool.js';
import { settingsOf } from './tenants.js';
import { emit } from './events.js';
import { getDms } from './dms/providers.js';

/** WhatsApp ordering for dealers: a cart per participant, then pushed to the brand's DMS. */
const CART_TTL_MIN = 120;
const rupee = (p) => `₹${(Number(p) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const orderNo = () => {
  const d = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(2, 10).replace(/-/g, '');
  return `WA-${d}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
};

export const canOrder = (tenant, p) => settingsOf(tenant).orderEnabledTypes.includes(p.type);

export async function catalog(tenantId) {
  const { rows } = await query(`SELECT id, sku, name, category, price_paise FROM products WHERE tenant_id=$1 AND active AND price_paise IS NOT NULL ORDER BY name`, [tenantId]);
  return rows;
}

export async function openCart(participantId) {
  const { rows: [c] } = await query(
    `SELECT * FROM orders WHERE participant_id=$1 AND status='CART' AND updated_at > now() - make_interval(mins => $2)`, [participantId, CART_TTL_MIN]);
  return c || null;
}

async function ensureCart(db, tenantId, participantId) {
  await db.query(`UPDATE orders SET status='CANCELLED', updated_at=now() WHERE participant_id=$1 AND status='CART' AND updated_at <= now() - make_interval(mins => $2)`, [participantId, CART_TTL_MIN]);
  const { rows: [c] } = await db.query(`SELECT * FROM orders WHERE participant_id=$1 AND status='CART' FOR UPDATE`, [participantId]);
  if (c) return c;
  const { rows: [n] } = await db.query(`INSERT INTO orders (tenant_id, participant_id, order_no) VALUES ($1,$2,$3) RETURNING *`, [tenantId, participantId, orderNo()]);
  return n;
}

const total = (items) => items.reduce((s, i) => s + i.qty * i.pricePaise, 0);

export async function startOrder({ tenant, participant }) {
  const items = await catalog(tenant.id);
  const cart = await tx((db) => ensureCart(db, tenant.id, participant.id));
  return { items, cart };
}

/** idx = 1-based position in the catalog as shown. qty 0 removes. */
export async function setItem({ tenant, participant, idx, qty }) {
  const items = await catalog(tenant.id);
  const p = items.at(idx - 1);
  if (!p || idx < 1) return { error: 'NO_SUCH_ITEM' };
  if (!(qty >= 0 && qty <= 100000)) return { error: 'BAD_QTY' };
  const cart = await tx(async (db) => {
    const c = await ensureCart(db, tenant.id, participant.id);
    const list = (c.items || []).filter((i) => i.productId !== p.id);
    if (qty > 0) list.push({ productId: p.id, sku: p.sku, name: p.name, qty, pricePaise: Number(p.price_paise) });
    const { rows: [u] } = await db.query(`UPDATE orders SET items=$2, total_paise=$3, updated_at=now() WHERE id=$1 RETURNING *`, [c.id, JSON.stringify(list), total(list)]);
    return u;
  });
  return { cart, product: p };
}

export async function confirm({ tenant, participant }) {
  return tx(async (db) => {
    const { rows: [c] } = await db.query(`SELECT * FROM orders WHERE participant_id=$1 AND status='CART' FOR UPDATE`, [participant.id]);
    if (!c || !c.items.length) return { error: 'EMPTY_CART' };
    const dms = settingsOf(tenant).orderDms;
    const { rows: [u] } = await db.query(`UPDATE orders SET status='PLACED', dms=$2, placed_at=now(), updated_at=now() WHERE id=$1 RETURNING *`, [c.id, dms]);
    await emit(db, tenant.id, 'order.placed', { orderId: u.id, orderNo: u.order_no, participantId: participant.id, totalPaise: Number(u.total_paise), items: u.items.length });
    return { order: u };
  });
}

export async function cancelCart({ participant }) {
  const r = await query(`UPDATE orders SET status='CANCELLED', updated_at=now() WHERE participant_id=$1 AND status='CART' RETURNING id`, [participant.id]);
  return r.rowCount > 0;
}

export const cartText = (c, lang = 'hi') => {
  if (!c?.items?.length) return lang === 'en' ? '🛒 Cart is empty.' : '🛒 Cart khaali hai.';
  return [`🛒 *${c.order_no}*`, ...c.items.map((i) => `• ${i.name} × ${i.qty} = ${rupee(i.qty * i.pricePaise)}`), `*Total: ${rupee(c.total_paise)}* (+GST as per invoice)`].join('\n');
};

export const catalogText = (items, lang = 'hi') => {
  if (!items.length) return lang === 'en' ? 'Ordering is not set up yet for this brand.' : 'Is brand ke liye ordering abhi set nahi hai.';
  const head = lang === 'en' ? '📦 *Order on WhatsApp*\nReply with item number and quantity, e.g. *1 20*' : '📦 *WhatsApp pe order karo*\nItem number aur quantity bhejo, jaise *1 20*';
  const foot = lang === 'en' ? '*cart* = view · *confirm* = place order · *cancel* = clear · *1 0* = remove item 1'
    : '*cart* = dekho · *confirm* = order bhejo · *cancel* = khaali karo · *1 0* = item 1 hatao';
  return [head, '', ...items.map((p, i) => `${i + 1}. ${p.name} (${p.sku}) — ${rupee(p.price_paise)}`), '', foot].join('\n');
};

/** Worker: push placed orders to the DMS. Retries up to 5 times. */
export async function pushPlaced(limit = 20) {
  const client = await pool.connect();
  const done = [];
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT o.*, row_to_json(p.*) AS participant, row_to_json(t.*) AS tenant FROM orders o
        JOIN participants p ON p.id=o.participant_id JOIN tenants t ON t.id=o.tenant_id
       WHERE o.status='PLACED' AND o.attempts < 5 ORDER BY o.placed_at LIMIT $1 FOR UPDATE OF o SKIP LOCKED`, [limit]);
    for (const o of rows) {
      try {
        const { ref } = await getDms(o.dms).push({ order: o, participant: o.participant, tenant: o.tenant });
        if (o.dms === 'none') { await client.query(`UPDATE orders SET attempts=attempts+1, updated_at=now() WHERE id=$1`, [o.id]); continue; }
        await client.query(`UPDATE orders SET status='SENT_TO_DMS', dms_order_ref=$2, attempts=attempts+1, error=NULL, updated_at=now() WHERE id=$1`, [o.id, ref]);
        await client.query(`INSERT INTO events (tenant_id, type, payload) VALUES ($1,'order.sent',$2)`, [o.tenant_id, { orderId: o.id, orderNo: o.order_no, participantId: o.participant_id, ref, totalPaise: Number(o.total_paise) }]);
        done.push(o.id);
      } catch (e) {
        const final = o.attempts + 1 >= 5;
        await client.query(`UPDATE orders SET attempts=attempts+1, error=$2, status=CASE WHEN $3 THEN 'FAILED' ELSE status END, updated_at=now() WHERE id=$1`, [o.id, e.message.slice(0, 300), final]);
        if (final) await client.query(`INSERT INTO events (tenant_id, type, payload) VALUES ($1,'order.failed',$2)`, [o.tenant_id, { orderId: o.id, orderNo: o.order_no, participantId: o.participant_id }]);
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return done.length;
}
