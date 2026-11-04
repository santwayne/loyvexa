/* Loyvexa mechanic PWA — vanilla JS, no build step. */
const T = {
  hi: {
    welcome: 'स्वागत है 🙏', welcomeSub: 'हर असली प्रोडक्ट पर QR स्कैन करो, पॉइंट्स कमाओ, सीधा UPI में पैसे पाओ।',
    mobile: 'मोबाइल नंबर', sendOtp: 'OTP भेजो', otp: 'OTP डालो', verify: 'आगे बढ़ो', name: 'आपका नाम', iam: 'मैं हूँ', city: 'शहर',
    yourPoints: 'आपके पॉइंट्स', history: 'हिस्ट्री', redeem: 'पैसे निकालो', profile: 'प्रोफाइल', redeemTitle: 'UPI में पैसे पाओ',
    upi: 'UPI ID', points: 'कितने पॉइंट्स', redeemNow: 'रिक्वेस्ट भेजो', payouts: 'पेमेंट्स', save: 'सेव करो', logout: 'लॉग आउट',
    scan: '📷  स्कैन करो', scanMore: 'और स्कैन करो', home: 'होम', submitCode: 'कोड जमा करो', cancel: 'बंद करो',
    worth: (r) => `= ₹${r}`, heldTxt: (h) => `${h} पॉइंट्स पेमेंट में`, min: (m, v) => `कम से कम ${m} पॉइंट्स · 1 पॉइंट = ₹${v}`,
    empty: 'अभी तक कोई स्कैन नहीं। पहला QR स्कैन करो!', success: 'पॉइंट्स मिल गए!', fail: 'स्कैन नहीं हुआ', sent: 'रिक्वेस्ट भेज दी ✅',
    camErr: 'कैमरा नहीं खुला। नीचे कोड टाइप करो।',
    errs: {
      INSUFFICIENT_POINTS: 'इतने पॉइंट्स नहीं हैं', BELOW_MINIMUM: 'कम से कम पॉइंट्स पूरे नहीं हुए', UPI_REQUIRED: 'पहले UPI ID डालो',
      INVALID_UPI: 'UPI ID सही नहीं है (जैसे name@okaxis)', DAILY_REDEEM_LIMIT: 'आज की लिमिट पूरी हो गई', OTP_INVALID: 'OTP गलत है',
      OTP_EXPIRED: 'OTP एक्सपायर हो गया, नया मंगाओ', OTP_LOCKED: 'बहुत बार गलत OTP, नया मंगाओ', INVALID_MOBILE: 'मोबाइल नंबर सही डालो',
      TOO_MANY_OTPS: 'बहुत सारे OTP मांगे, 15 मिनट बाद कोशिश करो',
      INVALID: 'ये कोड सही नहीं है। प्रोडक्ट नकली हो सकता है।', WRONG_BRAND: 'ये कोड किसी और ब्रांड का है।',
      ALREADY_SCANNED: 'ये कोड पहले ही इस्तेमाल हो चुका है।', VOID: 'ये कोड ब्रांड ने रद्द कर दिया है।',
      INACTIVE_PRODUCT: 'ये प्रोडक्ट अभी रिवॉर्ड में नहीं है।', LIMIT: 'स्कैन लिमिट पूरी हो गई, थोड़ी देर बाद कोशिश करो।',
      BLOCKED: 'स्कैनिंग अभी बंद है। ब्रांड से संपर्क करो।',
    },
    types: { MECHANIC: 'मैकेनिक', ELECTRICIAN: 'इलेक्ट्रीशियन', PLUMBER: 'प्लंबर', CONTRACTOR: 'कॉन्ट्रैक्टर', PAINTER: 'पेंटर', CARPENTER: 'कारपेंटर', RETAILER: 'दुकानदार' },
    st: { REQUESTED: 'मंज़ूरी बाकी', PROCESSING: 'प्रोसेसिंग', PAID: 'पेमेंट हो गया', FAILED: 'फेल (पॉइंट्स वापस)', REJECTED: 'रिजेक्ट (पॉइंट्स वापस)' },
    lt: { EARN_SCAN: 'स्कैन', REDEEM_HOLD: 'पैसे निकाले', REDEEM_RELEASE: 'पॉइंट्स वापस', ADJUST_CREDIT: 'बोनस', ADJUST_DEBIT: 'कटौती', BONUS: 'बोनस', EXPIRE: 'एक्सपायर' },
  },
  en: {
    welcome: 'Welcome 🙏', welcomeSub: 'Scan the QR on every genuine product, earn points, get cash straight to UPI.',
    mobile: 'Mobile number', sendOtp: 'Send OTP', otp: 'Enter OTP', verify: 'Continue', name: 'Your name', iam: 'I am a', city: 'City',
    yourPoints: 'Your points', history: 'History', redeem: 'Cash out', profile: 'Profile', redeemTitle: 'Get money in UPI',
    upi: 'UPI ID', points: 'Points', redeemNow: 'Send request', payouts: 'Payouts', save: 'Save', logout: 'Log out',
    scan: '📷  Scan', scanMore: 'Scan more', home: 'Home', submitCode: 'Submit code', cancel: 'Close',
    worth: (r) => `= ₹${r}`, heldTxt: (h) => `${h} points in payout`, min: (m, v) => `Minimum ${m} points · 1 point = ₹${v}`,
    empty: 'No scans yet. Scan your first QR!', success: 'Points added!', fail: 'Scan failed', sent: 'Request sent ✅',
    camErr: 'Camera unavailable. Type the code below.',
    errs: {},
    types: { MECHANIC: 'Mechanic', ELECTRICIAN: 'Electrician', PLUMBER: 'Plumber', CONTRACTOR: 'Contractor', PAINTER: 'Painter', CARPENTER: 'Carpenter', RETAILER: 'Retailer' },
    st: { REQUESTED: 'Awaiting approval', PROCESSING: 'Processing', PAID: 'Paid', FAILED: 'Failed (points returned)', REJECTED: 'Rejected (points returned)' },
    lt: { EARN_SCAN: 'Scan', REDEEM_HOLD: 'Cash out', REDEEM_RELEASE: 'Points returned', ADJUST_CREDIT: 'Bonus', ADJUST_DEBIT: 'Deduction', BONUS: 'Bonus', EXPIRE: 'Expired' },
  },
};

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return mem[k]; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { mem[k] = v; } },
};
const mem = {};
let lang = store.get('wl_lang') || 'hi';
let brand = qs.get('brand') || store.get('wl_brand');
let token = store.get(`wl_token_${brand}`);
let pendingCode = qs.get('code');
let info = null; let meData = null;
let deviceId = store.get('wl_device') || (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
store.set('wl_device', deviceId);
if (brand) store.set('wl_brand', brand);
const t = (k) => T[lang][k];
const errText = (code, fallback) => T[lang].errs?.[code] || fallback;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  if (!res.ok && !opts.allowFail) throw new Error(errText(json.error?.code, json.error?.message || json.message || 'Error'));
  return json;
}

function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach((el) => { const v = t(el.dataset.t); if (typeof v === 'string') el.textContent = v; });
  $('langBtn').textContent = lang === 'hi' ? 'English' : 'हिंदी';
  if (info) $('ptype').innerHTML = info.signupTypes.map((x) => `<option value="${x}">${t('types')[x] || x}</option>`).join('');
  if (meData) renderHome();
}
$('langBtn').onclick = () => { lang = lang === 'hi' ? 'en' : 'hi'; store.set('wl_lang', lang); applyLang(); };

const show = (id) => ['vLogin', 'vHome', 'vResult'].forEach((v) => $(v).classList.toggle('hidden', v !== id));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function setBrand(b) {
  $('brandName').textContent = b.name;
  document.title = `${b.name} Rewards`;
  document.documentElement.style.setProperty('--brand', b.brandColor || '#E85D04');
  document.querySelector('meta[name=theme-color]').content = b.brandColor || '#E85D04';
}

// ---------- Login ----------
$('sendOtp').onclick = async () => {
  $('loginErr').textContent = ''; $('sendOtp').disabled = true;
  try {
    const r = await api(`/api/p/${brand}/auth/otp/request`, { method: 'POST', body: { mobile: $('mobile').value } });
    $('stepMobile').classList.add('hidden'); $('stepOtp').classList.remove('hidden');
    $('newFields').classList.remove('hidden');
    if (r.devOtp) $('devOtp').textContent = `Dev OTP: ${r.devOtp}`;
    $('otp').focus();
  } catch (e) { $('loginErr').textContent = e.message; } finally { $('sendOtp').disabled = false; }
};
$('verifyOtp').onclick = async () => {
  $('loginErr').textContent = ''; $('verifyOtp').disabled = true;
  try {
    const r = await api(`/api/p/${brand}/auth/otp/verify`, { method: 'POST', body: { mobile: $('mobile').value, otp: $('otp').value, name: $('name').value || undefined, type: $('ptype').value, city: $('city').value || undefined } });
    token = r.token; store.set(`wl_token_${brand}`, token);
    await loadHome();
  } catch (e) { $('loginErr').textContent = e.message; } finally { $('verifyOtp').disabled = false; }
};
function logout() { token = null; store.set(`wl_token_${brand}`, null); meData = null; show('vLogin'); }
$('logout').onclick = logout;

// ---------- Home ----------
async function loadHome() {
  meData = await api('/api/p/me');
  setBrand(meData.brand);
  const [l, r] = await Promise.all([api('/api/p/ledger'), api('/api/p/redemptions')]);
  meData.ledger = l.entries; meData.redemptions = r.redemptions;
  renderHome(); show('vHome');
  if (pendingCode) { const c = pendingCode; pendingCode = null; history.replaceState(null, '', `?brand=${brand}`); submitScan(c); }
}
function renderHome() {
  const { wallet, rupeeValue, minRedeemPoints, pointValuePaise, participant } = meData;
  $('balance').textContent = wallet.balance.toLocaleString('en-IN');
  $('rupees').textContent = t('worth')(rupeeValue.toLocaleString('en-IN'));
  $('held').textContent = wallet.held ? t('heldTxt')(wallet.held) : '';
  $('redeemHint').textContent = t('min')(minRedeemPoints, pointValuePaise / 100);
  $('upi').value = participant.upiId || ''; $('pName').value = participant.name || ''; $('pCity').value = participant.city || '';
  $('pMobile').textContent = `+${participant.mobile}`;
  const fmt = (d) => new Date(d).toLocaleString(lang === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  $('ledger').innerHTML = meData.ledger.length ? meData.ledger.map((e) => `<div class="row"><div>${esc(t('lt')[e.type] || e.type)}<div class="muted">${esc(e.note || '')} · ${fmt(e.created_at)}</div></div><div class="${e.points > 0 ? 'plus' : 'minus'}">${e.points > 0 ? '+' : ''}${e.points}</div></div>`).join('') : `<p class="muted">${t('empty')}</p>`;
  $('redemptions').innerHTML = meData.redemptions.map((x) => `<div class="row"><div>₹${(x.amount_paise / 100).toLocaleString('en-IN')}<div class="muted">${esc(x.upi_id)} · ${fmt(x.created_at)}</div></div><div class="muted">${esc(t('st')[x.status])}</div></div>`).join('');
}
document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $('tHist').classList.toggle('hidden', b.dataset.tab !== 'hist');
  $('tRedeem').classList.toggle('hidden', b.dataset.tab !== 'redeem');
  $('tProfile').classList.toggle('hidden', b.dataset.tab !== 'profile');
});
$('redeemBtn').onclick = async () => {
  $('redeemErr').textContent = ''; $('redeemBtn').disabled = true;
  try {
    if ($('upi').value !== (meData.participant.upiId || '')) await api('/api/p/me', { method: 'PATCH', body: { upiId: $('upi').value.trim() } });
    await api('/api/p/redeem', { method: 'POST', body: { points: Number($('redeemPts').value) } });
    $('redeemPts').value = ''; $('redeemErr').textContent = t('sent');
    await loadHome();
  } catch (e) { $('redeemErr').textContent = e.message; } finally { $('redeemBtn').disabled = false; }
};
$('saveProfile').onclick = async () => { await api('/api/p/me', { method: 'PATCH', body: { name: $('pName').value, city: $('pCity').value } }); await loadHome(); };

// ---------- Scanning ----------
let stream = null; let scanning = false; let detector = null; let jsQRLoaded = false;
const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently: true });

function getPos() {
  return new Promise((res) => {
    if (!navigator.geolocation) return res({});
    navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res({}), { timeout: 3000, maximumAge: 600000 });
  });
}
function loadJsQR() {
  return new Promise((res) => {
    if (jsQRLoaded) return res(true);
    const s = document.createElement('script'); s.src = 'https://unpkg.com/jsqr@1.4.0/dist/jsQR.js';
    s.onload = () => { jsQRLoaded = true; res(true); }; s.onerror = () => res(false); document.head.appendChild(s);
  });
}
async function openCam() {
  $('camWrap').style.display = 'flex'; $('manualCode').value = '';
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    $('video').srcObject = stream; await $('video').play();
    if ('BarcodeDetector' in window) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    else await loadJsQR();
    scanning = true; requestAnimationFrame(tick);
  } catch { $('manualCode').placeholder = t('camErr'); }
}
function closeCam() { scanning = false; $('camWrap').style.display = 'none'; stream?.getTracks().forEach((x) => x.stop()); stream = null; }
async function tick() {
  if (!scanning) return;
  const v = $('video');
  try {
    if (v.readyState >= 2) {
      let text = null;
      if (detector) { const r = await detector.detect(v); text = r[0]?.rawValue; }
      else if (window.jsQR) {
        canvas.width = v.videoWidth; canvas.height = v.videoHeight; ctx.drawImage(v, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height); text = window.jsQR(img.data, img.width, img.height)?.data;
      }
      if (text) { closeCam(); navigator.vibrate?.(80); return submitScan(text); }
    }
  } catch { /* keep trying */ }
  setTimeout(() => requestAnimationFrame(tick), 120);
}
async function submitScan(code) {
  const pos = await getPos();
  const r = await api('/api/p/scan', { method: 'POST', body: { code, ...pos }, allowFail: true });
  $('rIcon').textContent = r.ok ? '🎉' : '⚠️';
  $('rTitle').textContent = r.ok ? `+${r.points} · ${t('success')}` : t('fail');
  $('rMsg').textContent = r.ok ? `${r.product.name}` : errText(r.result || r.error?.code, r.message || r.error?.message || '');
  show('vResult');
  meData = null; loadHome().then(() => show('vResult')).catch(() => {});
}
$('openScan').onclick = openCam; $('scanMore').onclick = openCam;
$('closeCam').onclick = closeCam;
$('manualBtn').onclick = () => { const c = $('manualCode').value.trim(); if (c) { closeCam(); submitScan(c); } };
$('backHome').onclick = () => show('vHome');

// ---------- Boot ----------
(async function boot() {
  if (!brand) { document.body.innerHTML = '<div class="wrap"><div class="card">Brand link missing. Open the link shared by your brand.</div></div>'; return; }
  try {
    info = await api(`/api/p/${brand}/info`);
    setBrand(info.brand); applyLang();
    if (token) await loadHome(); else show('vLogin');
  } catch (e) { document.body.innerHTML = `<div class="wrap"><div class="card">${esc(e.message)}</div></div>`; }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
