/* Loyvexa brand console — vanilla JS */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (paise) => `₹${(Number(paise) / 100).toLocaleString('en-IN')}`;
const num = (n) => Number(n || 0).toLocaleString('en-IN');
const dt = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const mem = {};
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return mem[k]; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { mem[k] = v; } } };

let token = store.get('wl_admin_token');
let user = JSON.parse(store.get('wl_admin_user') || 'null');
let tenantId = store.get('wl_admin_tenant');
let view = 'dashboard';

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(tenantId && user?.role === 'SUPER_ADMIN' ? { 'X-Tenant-Id': tenantId } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  if (opts.blob) return res.blob();
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || 'Request failed');
  return json;
}

// ---------- auth ----------
$('loginBtn').onclick = async () => {
  $('loginErr').textContent = '';
  try {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('email').value, password: $('password').value }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error?.message);
    token = j.token; user = j.user; store.set('wl_admin_token', token); store.set('wl_admin_user', JSON.stringify(user));
    if (user.role !== 'SUPER_ADMIN') tenantId = user.tenantId;
    boot();
  } catch (e) { $('loginErr').textContent = e.message; }
};
$('password').addEventListener('keydown', (e) => e.key === 'Enter' && $('loginBtn').click());
function logout() { token = null; store.set('wl_admin_token', null); store.set('wl_admin_user', null); store.set('wl_admin_tenant', null); location.reload(); }
$('logoutBtn').onclick = logout;

document.querySelectorAll('nav a[data-v]').forEach((a) => a.onclick = () => { view = a.dataset.v; document.querySelectorAll('nav a').forEach((x) => x.classList.toggle('on', x === a)); render(); });

async function boot() {
  if (!token) return;
  $('loginView').classList.add('hidden'); $('appView').classList.remove('hidden');
  if (user.role === 'SUPER_ADMIN') {
    const { tenants } = await api('/api/platform/tenants');
    $('tenantPick').classList.remove('hidden');
    $('tenantSelect').innerHTML = tenants.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
    if (!tenantId || !tenants.find((t) => t.id === tenantId)) tenantId = tenants[0]?.id;
    $('tenantSelect').value = tenantId || '';
    $('tenantSelect').onchange = () => { tenantId = $('tenantSelect').value; store.set('wl_admin_tenant', tenantId); render(); };
    if (!tenantId) { $('main').innerHTML = '<div class="panel">No brands yet. Create one via POST /api/platform/tenants.</div>'; return; }
  } else tenantId = user.tenantId;
  const { tenant } = await api('/api/admin/tenant');
  $('tenantName').textContent = `${tenant.name} · ${user.name}`;
  document.documentElement.style.setProperty('--brand', tenant.brand_color || '#E85D04');
  render();
}

const views = {};
async function render() {
  $('main').innerHTML = '<p class="muted">Loading…</p>';
  try { await views[view](); } catch (e) { $('main').innerHTML = `<div class="panel err">${esc(e.message)}</div>`; }
  if (view !== 'dashboard') refreshBadges();
}
async function refreshBadges() {
  try {
    const { kpis: k } = await api('/api/admin/dashboard?days=1');
    $('pendBadge').textContent = k.pending_redemptions; $('pendBadge').classList.toggle('hidden', !k.pending_redemptions);
    $('fraudBadge').textContent = k.open_fraud_flags; $('fraudBadge').classList.toggle('hidden', !k.open_fraud_flags);
  } catch { /* ignore */ }
}

// ---------- dashboard ----------
views.dashboard = async () => {
  const d = await api('/api/admin/dashboard?days=30');
  const k = d.kpis;
  $('pendBadge').textContent = k.pending_redemptions; $('pendBadge').classList.toggle('hidden', !k.pending_redemptions);
  $('fraudBadge').textContent = k.open_fraud_flags; $('fraudBadge').classList.toggle('hidden', !k.open_fraud_flags);
  const max = Math.max(1, ...d.daily.map((x) => Number(x.scans)));
  const tile = (v, l) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  $('main').innerHTML = `<h2>Dashboard</h2>
  <div class="kpis">
    ${tile(num(k.participants), 'Participants')}${tile(num(k.active_30d), 'Active (30 days)')}${tile(num(k.dormant), 'Dormant (30+ days)')}
    ${tile(num(k.scans_today), 'Scans today')}${tile(`${num(k.codes_scanned)} / ${num(k.codes_generated)}`, 'Codes scanned / printed')}
    ${tile(num(k.points_issued), 'Points issued')}${tile(num(k.points_liability), 'Points outstanding (liability)')}
    ${tile(inr(k.paid_paise), 'Paid out via UPI')}${tile(num(k.pending_redemptions), 'Payouts awaiting approval')}
  </div>
  <div class="panel"><h3>Scans per day — last 30 days</h3><div class="bars">${d.daily.map((x) => `<div title="${new Date(x.day).toLocaleDateString('en-IN')}: ${x.scans} scans" style="height:${(Number(x.scans) / max) * 100}%"></div>`).join('')}</div></div>
  <div class="grid2">
    <div class="panel"><h3>Top earners</h3><table><tr><th>Name</th><th>Type</th><th>City</th><th class="num">Points</th></tr>
      ${d.topEarners.map((x) => `<tr><td>${esc(x.name || '—')}</td><td>${esc(x.type)}</td><td>${esc(x.city || '—')}</td><td class="num">${num(x.lifetime_earned)}</td></tr>`).join('')}</table></div>
    <div class="panel"><h3>Scans by city</h3><table><tr><th>City</th><th class="num">Scans</th></tr>
      ${d.scansByCity.map((x) => `<tr><td>${esc(x.city)}</td><td class="num">${num(x.scans)}</td></tr>`).join('')}</table></div>
    <div class="panel"><h3>Top products</h3><table><tr><th>SKU</th><th>Product</th><th class="num">Scans</th></tr>
      ${d.topProducts.map((x) => `<tr><td>${esc(x.sku)}</td><td>${esc(x.name)}</td><td class="num">${num(x.scans)}</td></tr>`).join('')}</table></div>
    <div class="panel"><h3>Network by type</h3><table><tr><th>Type</th><th class="num">Total</th><th class="num">Active 30d</th></tr>
      ${d.participantsByType.map((x) => `<tr><td>${esc(x.type)}</td><td class="num">${num(x.n)}</td><td class="num">${num(x.active)}</td></tr>`).join('')}</table>
      <p class="muted" style="margin-top:12px">Authenticity checks (30d): ${num(d.authenticity.total_checks)} · reused codes ${num(d.authenticity.reused_code_checks)} · cancelled codes ${num(d.authenticity.void_code_checks)}</p></div>
  </div>`;
};

// ---------- products ----------
views.products = async () => {
  const { products } = await api('/api/admin/products');
  $('main').innerHTML = `<h2>Products</h2>
  <div class="panel"><h3>Add product</h3><div class="row">
    <div><label>SKU</label><input id="pSku"></div><div><label>Name</label><input id="pName"></div><div><label>Category</label><input id="pCat"></div>
    <div><label>Points per scan</label><input id="pPts" type="number" min="0"></div><div><label>Retailer points (optional)</label><input id="pRet" type="number" min="0"></div>
    <div style="flex:0"><button class="p" id="pAdd">Add</button></div></div><div class="err" id="pErr"></div></div>
  <div class="panel"><table><tr><th>SKU</th><th>Name</th><th>Category</th><th class="num">Points</th><th>Per type</th><th class="num">Printed</th><th class="num">Scanned</th><th>Status</th><th></th></tr>
  ${products.map((p) => `<tr><td>${esc(p.sku)}</td><td>${esc(p.name)}</td><td>${esc(p.category || '—')}</td><td class="num">${p.points}</td>
    <td class="muted">${esc(Object.entries(p.points_by_type || {}).map(([a, b]) => `${a}: ${b}`).join(', ') || '—')}</td>
    <td class="num">${num(p.codes_generated)}</td><td class="num">${num(p.codes_scanned)}</td>
    <td>${p.active ? '<span class="pill ok">Active</span>' : '<span class="pill">Paused</span>'}</td>
    <td><button class="sm" data-toggle="${p.id}" data-active="${p.active}">${p.active ? 'Pause' : 'Activate'}</button></td></tr>`).join('')}</table></div>`;
  $('pAdd').onclick = async () => {
    try {
      const ret = $('pRet').value;
      await api('/api/admin/products', { method: 'POST', body: { sku: $('pSku').value.trim(), name: $('pName').value.trim(), category: $('pCat').value.trim() || undefined, points: Number($('pPts').value || 0), pointsByType: ret !== '' ? { RETAILER: Number(ret) } : undefined } });
      render();
    } catch (e) { $('pErr').textContent = e.message; }
  };
  document.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = async () => { await api(`/api/admin/products/${b.dataset.toggle}`, { method: 'PATCH', body: { active: b.dataset.active !== 'true' } }); render(); });
};

// ---------- QR batches ----------
views.qr = async () => {
  const [{ products }, { batches }] = await Promise.all([api('/api/admin/products'), api('/api/admin/qr-batches')]);
  $('main').innerHTML = `<h2>QR batches</h2>
  <div class="panel"><h3>Generate codes</h3><div class="row">
    <div><label>Product</label><select id="bProd">${products.filter((p) => p.active).map((p) => `<option value="${p.id}">${esc(p.sku)} — ${esc(p.name)}</option>`).join('')}</select></div>
    <div><label>Quantity</label><input id="bQty" type="number" min="1" max="100000" value="1000"></div>
    <div><label>Mfg date</label><input id="bDate" type="date"></div><div><label>Label / lot no.</label><input id="bLabel"></div>
    <div style="flex:0"><button class="p" id="bGen">Generate</button></div></div>
    <p class="muted">Download the CSV and send it to your label printer / packaging vendor. Each row has a unique code and its QR link.</p><div class="err" id="bErr"></div></div>
  <div class="panel"><table><tr><th>Created</th><th>Product</th><th>Label</th><th>Mfg</th><th class="num">Qty</th><th class="num">Scanned</th><th>Status</th><th></th></tr>
  ${batches.map((b) => `<tr><td>${dt(b.created_at)}</td><td>${esc(b.sku)} — ${esc(b.product_name)}</td><td>${esc(b.label || '—')}</td><td>${b.mfg_date ? esc(b.mfg_date.slice(0, 10)) : '—'}</td>
    <td class="num">${num(b.quantity)}</td><td class="num">${num(b.scanned)} (${Math.round((b.scanned / b.quantity) * 100)}%)</td>
    <td>${b.status === 'ACTIVE' ? '<span class="pill ok">Active</span>' : '<span class="pill bad">Void</span>'}</td>
    <td><button class="sm" data-csv="${b.id}" data-name="${esc(b.sku)}">CSV</button> ${b.status === 'ACTIVE' ? `<button class="sm danger" data-void="${b.id}">Void</button>` : ''}</td></tr>`).join('')}</table></div>`;
  $('bGen').onclick = async () => {
    $('bGen').disabled = true;
    try { await api('/api/admin/qr-batches', { method: 'POST', body: { productId: $('bProd').value, quantity: Number($('bQty').value), mfgDate: $('bDate').value || undefined, label: $('bLabel').value || undefined } }); render(); }
    catch (e) { $('bErr').textContent = e.message; $('bGen').disabled = false; }
  };
  document.querySelectorAll('[data-csv]').forEach((b) => b.onclick = async () => {
    const blob = await api(`/api/admin/qr-batches/${b.dataset.csv}/export.csv`, { blob: true });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `qr-${b.dataset.name}-${b.dataset.csv.slice(0, 8)}.csv`; a.click();
  });
  document.querySelectorAll('[data-void]').forEach((b) => b.onclick = async () => {
    if (!confirm('Void this batch? Unscanned codes will stop working permanently.')) return;
    await api(`/api/admin/qr-batches/${b.dataset.void}/void`, { method: 'POST' }); render();
  });
};

// ---------- participants ----------
let pQuery = '';
views.participants = async () => {
  const { participants, total } = await api(`/api/admin/participants?limit=200&q=${encodeURIComponent(pQuery)}`);
  $('main').innerHTML = `<h2>Participants <span class="muted" style="font-size:14px">(${num(total)})</span></h2>
  <div class="panel"><div class="row"><div><input id="pq" placeholder="Search name, mobile, city" value="${esc(pQuery)}"></div><div style="flex:0"><button id="pqBtn">Search</button></div></div></div>
  <div class="panel"><table><tr><th>Name</th><th>Type</th><th>Mobile</th><th>City</th><th class="num">Balance</th><th class="num">Lifetime</th><th>Last scan</th><th>Status</th><th></th></tr>
  ${participants.map((p) => `<tr><td>${esc(p.name || '—')}</td><td>${esc(p.type)}</td><td>${esc(p.mobile)}</td><td>${esc(p.city || '—')}</td>
    <td class="num">${num(p.balance)}</td><td class="num">${num(p.lifetime_earned)}</td><td>${dt(p.last_scan_at)}</td>
    <td>${p.status === 'ACTIVE' ? '<span class="pill ok">Active</span>' : '<span class="pill bad">Blocked</span>'}</td>
    <td><button class="sm ${p.status === 'ACTIVE' ? 'danger' : ''}" data-block="${p.id}" data-status="${p.status}">${p.status === 'ACTIVE' ? 'Block' : 'Unblock'}</button>
        <button class="sm" data-adj="${p.id}">± Points</button></td></tr>`).join('')}</table></div>`;
  $('pqBtn').onclick = () => { pQuery = $('pq').value; render(); };
  $('pq').addEventListener('keydown', (e) => e.key === 'Enter' && $('pqBtn').click());
  document.querySelectorAll('[data-block]').forEach((b) => b.onclick = async () => {
    await api(`/api/admin/participants/${b.dataset.block}`, { method: 'PATCH', body: { status: b.dataset.status === 'ACTIVE' ? 'BLOCKED' : 'ACTIVE', clearScanBlock: true } }); render();
  });
  document.querySelectorAll('[data-adj]').forEach((b) => b.onclick = async () => {
    const pts = Number(prompt('Points to add (use minus to deduct):')); if (!pts) return;
    const note = prompt('Reason (shown in their history):'); if (!note) return;
    try { await api(`/api/admin/participants/${b.dataset.adj}/adjust`, { method: 'POST', body: { points: pts, note, idempotencyKey: `ui-${crypto.randomUUID?.() || Date.now()}` } }); render(); }
    catch (e) { alert(e.message); }
  });
};

// ---------- redemptions ----------
let rStatus = 'REQUESTED';
views.redemptions = async () => {
  const { redemptions } = await api(`/api/admin/redemptions?status=${rStatus}&limit=200`);
  const total = redemptions.reduce((s, r) => s + Number(r.amount_paise), 0);
  $('main').innerHTML = `<h2>Redemptions</h2>
  <div class="panel"><div class="row"><div style="flex:0;min-width:200px"><select id="rs">${['REQUESTED', 'PROCESSING', 'PAID', 'FAILED', 'REJECTED'].map((s) => `<option ${s === rStatus ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
  <div class="muted">${redemptions.length} requests · ${inr(total)}</div></div></div>
  <div class="panel"><table><tr><th>Requested</th><th>Participant</th><th>Type</th><th>City</th><th>UPI</th><th class="num">Points</th><th class="num">Amount</th><th>Status</th><th></th></tr>
  ${redemptions.map((r) => `<tr><td>${dt(r.created_at)}</td><td>${esc(r.participant_name || '—')}<div class="muted">${esc(r.mobile)}</div></td><td>${esc(r.participant_type)}</td><td>${esc(r.city || '—')}</td>
    <td>${esc(r.upi_id)}</td><td class="num">${num(r.points)}</td><td class="num">${inr(r.amount_paise)}</td>
    <td><span class="pill ${r.status === 'PAID' ? 'ok' : ['FAILED', 'REJECTED'].includes(r.status) ? 'bad' : 'warn'}">${r.status}</span>${r.failure_reason ? `<div class="muted">${esc(r.failure_reason)}</div>` : ''}</td>
    <td>${r.status === 'REQUESTED' ? `<button class="sm p" data-ap="${r.id}">Approve &amp; pay</button> <button class="sm danger" data-rj="${r.id}">Reject</button>` : ''}</td></tr>`).join('')}</table></div>`;
  $('rs').onchange = () => { rStatus = $('rs').value; render(); };
  document.querySelectorAll('[data-ap]').forEach((b) => b.onclick = async () => { b.disabled = true; try { await api(`/api/admin/redemptions/${b.dataset.ap}/approve`, { method: 'POST' }); } catch (e) { alert(e.message); } render(); });
  document.querySelectorAll('[data-rj]').forEach((b) => b.onclick = async () => { const reason = prompt('Reason for rejection:'); if (!reason) return; await api(`/api/admin/redemptions/${b.dataset.rj}/reject`, { method: 'POST', body: { reason } }); render(); });
};

// ---------- fraud ----------
const RULES = {
  REPEATED_INVALID_SCANS: 'Many invalid / reused codes in an hour — scanning auto-paused',
  SCANNED_SOMEONE_ELSES_CODE: 'Tried a code already claimed by someone else',
  BURST_SCANNING: 'Scanning unusually fast',
  DAILY_LIMIT_REACHED: 'Hit the daily scan limit',
  SHARED_DEVICE: 'Same phone used by several accounts',
};
views.fraud = async () => {
  const { flags } = await api('/api/admin/fraud-flags');
  $('main').innerHTML = `<h2>Fraud flags</h2><div class="panel">${flags.length ? `<table><tr><th>When</th><th>Participant</th><th>Rule</th><th>Details</th><th></th></tr>
  ${flags.map((f) => `<tr><td>${dt(f.created_at)}</td><td>${esc(f.participant_name || '—')}<div class="muted">${esc(f.mobile || '')} · ${esc(f.participant_type || '')}</div></td>
    <td><b>${esc(f.rule)}</b><div class="muted">${esc(RULES[f.rule] || '')}</div></td><td class="muted">${esc(JSON.stringify(f.details))}</td>
    <td><button class="sm" data-res="${f.id}">Resolve</button> ${f.participant_id ? `<button class="sm danger" data-blk="${f.participant_id}">Block user</button>` : ''}</td></tr>`).join('')}</table>` : '<p class="muted">No open flags 🎉</p>'}</div>`;
  document.querySelectorAll('[data-res]').forEach((b) => b.onclick = async () => { await api(`/api/admin/fraud-flags/${b.dataset.res}/resolve`, { method: 'POST' }); render(); });
  document.querySelectorAll('[data-blk]').forEach((b) => b.onclick = async () => { if (!confirm('Block this participant?')) return; await api(`/api/admin/participants/${b.dataset.blk}`, { method: 'PATCH', body: { status: 'BLOCKED' } }); render(); });
};

// ---------- settings ----------
views.settings = async () => {
  const { tenant } = await api('/api/admin/tenant');
  const s = tenant.settings;
  const appLink = `${location.origin}/app/?brand=${tenant.slug}`;
  const f = (k, l) => `<div><label>${l}</label><input type="number" data-set="${k}" value="${s[k]}"></div>`;
  $('main').innerHTML = `<h2>Settings</h2>
  <div class="panel"><h3>Mechanic app link</h3><p>Share this link on WhatsApp with your dealers and mechanics:</p><input readonly value="${esc(appLink)}"></div>
  <div class="panel"><h3>Programme rules</h3><div class="row">
    ${f('pointValuePaise', 'Value of 1 point (paise)')}${f('minRedeemPoints', 'Minimum points to cash out')}${f('maxRedeemPointsPerDay', 'Max cash-out points per day')}
    ${f('autoApproveRedeemUptoPoints', 'Auto-approve payouts up to (points, 0 = off)')}</div><div class="row">
    ${f('dailyScanLimit', 'Scans per person per day')}${f('burstScanLimit', 'Scans allowed per minute')}${f('invalidScanLimitPerHour', 'Invalid scans before pause')}${f('maxParticipantsPerDevice', 'Accounts per phone')}</div>
    <button class="p" style="margin-top:14px" id="saveSet">Save</button><div class="err" id="setErr"></div></div>`;
  $('saveSet').onclick = async () => {
    const settings = {}; document.querySelectorAll('[data-set]').forEach((i) => { settings[i.dataset.set] = Number(i.value); });
    try { await api('/api/admin/tenant', { method: 'PATCH', body: { settings } }); $('setErr').textContent = 'Saved ✓'; } catch (e) { $('setErr').textContent = e.message; }
  };
};

boot().catch(() => logout());
