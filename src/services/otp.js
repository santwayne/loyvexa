import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { sha256 } from '../lib/codes.js';
import { config } from '../config.js';
import { badRequest, AppError } from '../lib/errors.js';

const TTL_MIN = 10;
const MAX_ATTEMPTS = 5;

/**
 * Sends OTP. Phase 1: dev mode returns it in the response.
 * Phase 2: plug in WhatsApp Cloud API (reuse Regulars sender) with an authentication template.
 */
async function deliver({ mobile, code }) {
  if (config.otpDevMode) return;
  // TODO(phase2): WhatsApp authentication template via Regulars' WhatsApp Cloud API client
  console.log(`[otp] would send OTP to ${mobile}`);
}

export async function requestOtp({ tenantId, mobile }) {
  const { rows: [recent] } = await query(
    `SELECT count(*) AS n FROM otp_codes WHERE tenant_id=$1 AND mobile=$2 AND created_at > now() - interval '15 minutes'`, [tenantId, mobile]);
  if (Number(recent.n) >= 5) throw new AppError(429, 'TOO_MANY_OTPS', 'Too many OTP requests. Try again in 15 minutes.');
  const code = String(crypto.randomInt(100000, 1000000));
  await query(`INSERT INTO otp_codes (tenant_id, mobile, code_hash, expires_at) VALUES ($1,$2,$3, now() + make_interval(mins => $4))`,
    [tenantId, mobile, sha256(`${mobile}:${code}`), TTL_MIN]);
  await deliver({ mobile, code });
  return config.otpDevMode ? { sent: true, devOtp: code } : { sent: true };
}

export async function verifyOtp({ tenantId, mobile, code }) {
  const { rows: [o] } = await query(
    `SELECT * FROM otp_codes WHERE tenant_id=$1 AND mobile=$2 AND consumed_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`, [tenantId, mobile]);
  if (!o) throw badRequest('OTP_EXPIRED', 'OTP expired. Request a new one.');
  if (o.attempts >= MAX_ATTEMPTS) throw badRequest('OTP_LOCKED', 'Too many wrong attempts. Request a new OTP.');
  const ok = o.code_hash === sha256(`${mobile}:${String(code).trim()}`);
  if (!ok) {
    await query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id=$1`, [o.id]);
    throw badRequest('OTP_INVALID', 'Wrong OTP');
  }
  await query(`UPDATE otp_codes SET consumed_at = now() WHERE id=$1`, [o.id]);
  return true;
}
