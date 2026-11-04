import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { ah, badRequest } from '../lib/errors.js';
import { extractCode, formatCode } from '../lib/codes.js';
import { verify } from '../services/qr.js';
import { getProvider } from '../services/payouts/index.js';
import { settleRedemption } from '../services/redemption.js';
import { getCallProvider } from '../services/calls/providers.js';
import { settleCall } from '../services/calls/index.js';
import { config } from '../config.js';

const r = Router();
const verifyLimiter = rateLimit({ windowMs: 60_000, limit: config.verifyRateLimitPerMinute, standardHeaders: true, legacyHeaders: false });

r.get('/api/public/verify/:code', verifyLimiter, ah(async (req, res) => {
  const code = extractCode(req.params.code);
  if (!code) throw badRequest('INVALID_CODE', 'Invalid code');
  res.json(await verify({ code, ip: req.ip, userAgent: req.headers['user-agent'] }));
}));

// Payout provider webhooks (final payout status)
r.post('/api/webhooks/payouts/:provider', ah(async (req, res) => {
  const evt = getProvider(req.params.provider).parseWebhook(req);
  if (!evt?.redemptionId) return res.status(400).json({ ok: false });
  await settleRedemption(evt);
  res.json({ ok: true });
}));

// AI call outcomes (WayneRing or mock)
r.post('/api/webhooks/calls/:provider', ah(async (req, res) => {
  let p; try { p = getCallProvider(req.params.provider); } catch { return res.status(404).json({ ok: false }); }
  const evt = p.parseWebhook(req);
  if (!evt || !(evt.callId || evt.providerCallId)) return res.status(400).json({ ok: false });
  await settleCall(evt);
  res.json({ ok: true });
}));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// What a normal phone camera opens when someone scans the product's QR.
r.get('/q/:code', verifyLimiter, ah(async (req, res) => {
  const code = extractCode(req.params.code);
  const v = code ? await verify({ code, ip: req.ip, userAgent: req.headers['user-agent'] }) : { result: 'NOT_FOUND', genuine: false };
  const color = v.brand?.color || '#B00020';
  const states = {
    GENUINE: ['✅', 'Genuine product', 'Asli product', 'Reward not yet claimed. Mechanics: scan in the app to earn points.'],
    ALREADY_SCANNED: ['✅', 'Genuine product', 'Asli product', 'The reward for this code has already been claimed.'],
    VOID: ['⚠️', 'Code cancelled', 'Code radd kiya gaya', 'The brand has cancelled this code. Contact the seller.'],
    NOT_FOUND: ['❌', 'Not recognised', 'Code nahi mila', 'We could not find this code. The product may not be genuine — please report it to the brand.'],
  };
  const [icon, title, titleHi, line] = states[v.result];
  const appUrl = v.brand ? `${config.publicBaseUrl}/app/?brand=${encodeURIComponent(v.brand.slug)}&code=${encodeURIComponent(code)}` : null;
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(v.brand?.name || config.productName)}</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f6f4;color:#1b1b1b}
.wrap{max-width:440px;margin:0 auto;padding:28px 20px}.card{background:#fff;border-radius:18px;padding:28px 22px;box-shadow:0 2px 14px rgba(0,0,0,.06);text-align:center}
.brand{font-weight:700;letter-spacing:.02em;color:${esc(color)};margin-bottom:18px}.icon{font-size:56px}h1{margin:8px 0 2px;font-size:24px}.hi{color:#666;margin:0 0 14px}
.meta{text-align:left;background:#fafafa;border-radius:12px;padding:12px 14px;margin:16px 0;font-size:14px;line-height:1.7}.meta b{display:inline-block;min-width:92px;color:#666;font-weight:500}
.btn{display:block;background:${esc(color)};color:#fff;text-decoration:none;padding:14px;border-radius:12px;font-weight:600;margin-top:12px}.foot{text-align:center;color:#999;font-size:12px;margin-top:18px}</style></head>
<body><div class="wrap"><div class="card"><div class="brand">${esc(v.brand?.name || '')}</div><div class="icon">${icon}</div><h1>${esc(title)}</h1><p class="hi">${esc(titleHi)}</p><p>${esc(line)}</p>
${v.product ? `<div class="meta"><div><b>Product</b>${esc(v.product.name)}</div><div><b>SKU</b>${esc(v.product.sku)}</div>${v.mfgDate ? `<div><b>Mfg date</b>${esc(v.mfgDate)}</div>` : ''}<div><b>Code</b>${esc(formatCode(code))}</div></div>` : ''}
${v.result === 'GENUINE' && appUrl ? `<a class="btn" href="${esc(appUrl)}">Scan karke points kamao →</a>` : ''}</div>
<div class="foot">Verified by ${esc(config.productName)}</div></div></body></html>`);
}));

export default r;
