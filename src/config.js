import 'dotenv/config';

const bool = (v, d = false) => (v === undefined ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));

export const config = {
  productName: process.env.PRODUCT_NAME || 'Loyvexa',
  port: Number(process.env.PORT || 4000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://loyvexa:loyvexa@localhost:5432/loyvexa',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-change-me',
  adminTokenTtl: process.env.ADMIN_TOKEN_TTL || '12h',
  participantTokenTtl: process.env.PARTICIPANT_TOKEN_TTL || '60d',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'http://localhost:4000').replace(/\/$/, ''),
  otpDevMode: bool(process.env.OTP_DEV_MODE, true), // returns OTP in API response; NEVER enable in production
  payoutProvider: process.env.PAYOUT_PROVIDER || 'mock',
  otpRateLimitPerMinute: Number(process.env.OTP_RATE_LIMIT_PER_MINUTE || 10),
  verifyRateLimitPerMinute: Number(process.env.VERIFY_RATE_LIMIT_PER_MINUTE || 30),
  encryptionKey: process.env.ENCRYPTION_KEY || 'dev-only-encryption-key',
  whatsapp: {
    sendMode: process.env.WHATSAPP_SEND_MODE || 'mock', // mock | live
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'dev-verify-token',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',     // enables X-Hub-Signature-256 check
    graphVersion: process.env.WHATSAPP_GRAPH_VERSION || 'v21.0',
  },
  workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS || 15000),
  corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()),
};

// Per-tenant defaults; anything in tenants.settings overrides these.
export const DEFAULT_TENANT_SETTINGS = {
  pointValuePaise: 100,          // 1 point = ₹1
  minRedeemPoints: 100,
  maxRedeemPointsPerDay: 5000,
  autoApproveRedeemUptoPoints: 0, // 0 = every redemption needs admin approval
  dailyScanLimit: 50,
  burstScanLimit: 10,            // scans per burstWindowSeconds before flag
  burstWindowSeconds: 60,
  invalidScanLimitPerHour: 5,    // then scanning is paused
  invalidScanBlockMinutes: 60,
  maxParticipantsPerDevice: 3,
  allowSelfSignup: true,
  selfSignupTypes: ['MECHANIC', 'ELECTRICIAN', 'PLUMBER', 'CONTRACTOR', 'PAINTER', 'CARPENTER', 'RETAILER'],
  // Purchase-based earning from invoices (accounting / DMS connectors)
  purchaseEarnEnabled: true,
  purchasePointsPer1000: 10,     // 10 points per ₹1,000 taxable value (unless product overrides per unit)
  purchaseEarnTypes: ['DEALER', 'DISTRIBUTOR', 'RETAILER'],
};

if (process.env.NODE_ENV === 'production') {
  if (config.jwtSecret === 'dev-only-change-me') throw new Error('JWT_SECRET must be set in production');
  if (config.otpDevMode) throw new Error('OTP_DEV_MODE must be false in production');
  if (config.encryptionKey === 'dev-only-encryption-key') throw new Error('ENCRYPTION_KEY must be set in production');
}
