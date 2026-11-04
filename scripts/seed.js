// Creates the platform super admin (Wayne E Solutions) and optionally a demo brand.
// Usage: node scripts/seed.js [--demo]
import bcrypt from 'bcryptjs';
import { pool, tx } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

const SUPER_EMAIL = process.env.SUPER_ADMIN_EMAIL || 'admin@wayneesolutions.com';
const SUPER_PASS = process.env.SUPER_ADMIN_PASSWORD || 'ChangeMe@123';

await migrate();
await tx(async (db) => {
  await db.query(
    `INSERT INTO admin_users (tenant_id, name, email, password_hash, role) VALUES (NULL,'Platform Admin',$1,$2,'SUPER_ADMIN')
     ON CONFLICT (email) DO NOTHING`, [SUPER_EMAIL, await bcrypt.hash(SUPER_PASS, 10)]);
  console.log(`super admin: ${SUPER_EMAIL}`);

  if (process.argv.includes('--demo')) {
    const { rows: [t] } = await db.query(
      `INSERT INTO tenants (name, slug, brand_color, settings) VALUES ('Demo Auto Parts','demo-auto','#C1121F',$1)
       ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING *`,
      [{ pointValuePaise: 100, minRedeemPoints: 100 }]);
    await db.query(
      `INSERT INTO admin_users (tenant_id, name, email, password_hash, role) VALUES ($1,'Demo Brand Admin','brand@demo-auto.in',$2,'TENANT_ADMIN')
       ON CONFLICT (email) DO NOTHING`, [t.id, await bcrypt.hash('Demo@12345', 10)]);
    for (const [sku, name, cat, pts, byType] of [
      ['BRK-PAD-110', 'Brake Pad Set (110cc)', 'Brakes', 20, { RETAILER: 5 }],
      ['CLT-PLT-150', 'Clutch Plate (150cc)', 'Clutch', 35, { RETAILER: 8 }],
      ['CHN-KIT-100', 'Chain Sprocket Kit', 'Transmission', 50, { RETAILER: 10 }],
    ]) {
      await db.query(
        `INSERT INTO products (tenant_id, sku, name, category, points, points_by_type) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, sku) DO NOTHING`,
        [t.id, sku, name, cat, pts, byType]);
    }
    console.log('demo brand: demo-auto  (brand@demo-auto.in / Demo@12345)');
  }
});
await pool.end();
