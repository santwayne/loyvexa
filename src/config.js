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
  calls: {
    provider: process.env.CALL_PROVIDER || 'mock', // mock | waynering
    wayneringBaseUrl: process.env.WAYNERING_BASE_URL || '',
    wayneringApiKey: process.env.WAYNERING_API_KEY || '',
    webhookSecret: process.env.CALL_WEBHOOK_SECRET || '',
  },
  korvo: {
    baseUrl: process.env.KORVO_BASE_URL || '',
    apiKey: process.env.KORVO_API_KEY || '',
  },
  // Bundle B one platform: secret shared with Korvo (HUB_SECRET there) for
  // automatic set-up and one-click sign-in from the Korvo app.
  hubSecret: process.env.HUB_SECRET_KORVO || '',
  // Optional: Claude writes the weekly insight. Without a key a plain summary is used.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  aiModel: process.env.AI_MODEL || 'claude-haiku-5-5',
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
  // Phase 3 — segmentation
  segNewDays: 14,                // joined within N days and not yet a regular
  segAtRiskDays: 21,             // no activity for N days -> AT_RISK
  segDormantDays: 45,            // no activity for N days -> DORMANT
  segHighValuePoints90d: 2000,   // earned >= N points in 90 days and active -> HIGH_SPENDER
  // Phase 3 — AI calls
  callHoursStart: 9,             // IST, inclusive
  callHoursEnd: 21,              // IST, exclusive
  callCooldownDays: 7,           // max one call per participant per N days
  // Phase 3 — WhatsApp ordering
  orderDms: 'mock',              // mock | korvo | none (record only, brand team processes)
  orderEnabledTypes: ['DEALER', 'DISTRIBUTOR', 'RETAILER'],
  // Phase 3 — WhatsApp campaigns
  waCampaignPerTick: 60,         // messages per worker tick
  waCampaignDailyCap: 1000,      // campaign messages per brand per day
  // Phase 3 — points expiry
  pointsExpiryMonths: 0,         // 0 = points never expire
  expiryReminderDays: 30,
  // Phase 4 — AI Channel Manager (Bundle B). Off until the brand switches it on.
  aiEnabled: false,
  aiBriefNumbers: [],            // owner / sales-head mobiles that get the morning plan and can approve by WhatsApp
  aiBriefHour: 9,                // IST
  aiContactFromHour: 10,         // IST: no dealer / mechanic messages before…
  aiContactToHour: 20,           // …or after this hour
  aiAutonomy: {},                // per action type: SUGGEST | APPROVE | AUTO (defaults in services/ai/settings.js)
  aiDailyCap: 25,                // actions per day
  aiMaxTouchesPerWeek: 2,        // AI messages/calls per person per 7 days
  aiReorderMinOrders: 3,         // invoices needed before predicting a reorder
  aiSlabPushDays: 10,            // push near-slab participants when a scheme ends within N days
  aiSlabPushWithinPct: 30,       // …and they are within N% of the next slab
  aiOverdueDays: 15,             // payment reminder after N days past due
  aiOverdueMinRupees: 5000,      // …and at least this much overdue
  aiWinbackMinRupees: 25000,     // dealer bought at least this much in the 180 days before going quiet
};

if (process.env.NODE_ENV === 'production') {
  if (config.jwtSecret === 'dev-only-change-me') throw new Error('JWT_SECRET must be set in production');
  if (config.otpDevMode) throw new Error('OTP_DEV_MODE must be false in production');
  if (config.encryptionKey === 'dev-only-encryption-key') throw new Error('ENCRYPTION_KEY must be set in production');
}
