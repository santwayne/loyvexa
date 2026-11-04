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
    $('unmBadge').textContent = k.unmatched_invoices; $('unmBadge').classList.toggle('hidden', !k.unmatched_invoices);
    $('ordBadge').textContent = k.orders_waiting; $('ordBadge').classList.toggle('hidden', !k.orders_waiting);
  } catch { /* ignore */ }
}

// ---------- dashboard ----------
views.dashboard = async () => {
  const d = await api('/api/admin/dashboard?days=30');
  const k = d.kpis;
  $('pendBadge').textContent = k.pending_redemptions; $('pendBadge').classList.toggle('hidden', !k.pending_redemptions);
  $('fraudBadge').textContent = k.open_fraud_flags; $('fraudBadge').classList.toggle('hidden', !k.open_fraud_flags);
  $('unmBadge').textContent = k.unmatched_invoices; $('unmBadge').classList.toggle('hidden', !k.unmatched_invoices);
  $('ordBadge').textContent = k.orders_waiting; $('ordBadge').classList.toggle('hidden', !k.orders_waiting);
  const max = Math.max(1, ...d.daily.map((x) => Number(x.scans)));
  const tile = (v, l) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  $('main').innerHTML = `<h2>Dashboard</h2>
  <div class="kpis">
    ${tile(num(k.participants), 'Participants')}${tile(num(k.active_30d), 'Active (30 days)')}${tile(num(k.dormant), 'Dormant (30+ days)')}
    ${tile(num(k.scans_today), 'Scans today')}${tile(`${num(k.codes_scanned)} / ${num(k.codes_generated)}`, 'Codes scanned / printed')}
    ${tile(num(k.points_issued), 'Points issued')}${tile(num(k.points_liability), 'Points outstanding (liability)')}
    ${tile(inr(k.paid_paise), 'Paid out via UPI')}${tile(num(k.pending_redemptions), 'Payouts awaiting approval')}
    ${tile(inr(k.purchase_paise_30d), 'Dealer purchases (30 days)')}${tile(num(k.active_schemes), 'Live schemes')}
    ${tile(num(k.at_risk), 'At risk + dormant')}${tile(inr(k.wa_orders_paise_30d), 'WhatsApp orders (30 days)')}
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
    <div><label>Points per scan</label><input id="pPts" type="number" min="0"></div><div><label>Dealer price ₹ (for ordering)</label><input id="pPrice" type="number" min="0" step="0.01"></div><div><label>Retailer points (optional)</label><input id="pRet" type="number" min="0"></div>
    <div style="flex:0"><button class="p" id="pAdd">Add</button></div></div><div class="err" id="pErr"></div></div>
  <div class="panel"><table><tr><th>SKU</th><th>Name</th><th>Category</th><th class="num">Price</th><th class="num">Points</th><th>Per type</th><th class="num">Printed</th><th class="num">Scanned</th><th>Status</th><th></th></tr>
  ${products.map((p) => `<tr><td>${esc(p.sku)}</td><td>${esc(p.name)}</td><td>${esc(p.category || '—')}</td><td class="num">${p.price_paise != null ? inr(p.price_paise) : '—'}</td><td class="num">${p.points}</td>
    <td class="muted">${esc(Object.entries(p.points_by_type || {}).map(([a, b]) => `${a}: ${b}`).join(', ') || '—')}</td>
    <td class="num">${num(p.codes_generated)}</td><td class="num">${num(p.codes_scanned)}</td>
    <td>${p.active ? '<span class="pill ok">Active</span>' : '<span class="pill">Paused</span>'}</td>
    <td><button class="sm" data-toggle="${p.id}" data-active="${p.active}">${p.active ? 'Pause' : 'Activate'}</button></td></tr>`).join('')}</table></div>`;
  $('pAdd').onclick = async () => {
    try {
      const ret = $('pRet').value;
      await api('/api/admin/products', { method: 'POST', body: { sku: $('pSku').value.trim(), name: $('pName').value.trim(), category: $('pCat').value.trim() || undefined, points: Number($('pPts').value || 0), pricePaise: $('pPrice').value !== '' ? Math.round(Number($('pPrice').value) * 100) : undefined, pointsByType: ret !== '' ? { RETAILER: Number(ret) } : undefined } });
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
let pQuery = ''; let pSeg = '';
views.participants = async () => {
  const { participants, total } = await api(`/api/admin/participants?limit=200&q=${encodeURIComponent(pQuery)}&segment=${pSeg}`);
  $('main').innerHTML = `<h2>Participants <span class="muted" style="font-size:14px">(${num(total)})</span></h2>
  <div class="panel"><div class="row"><div><input id="pq" placeholder="Search name, mobile, city" value="${esc(pQuery)}"></div><div style="flex:0;min-width:180px"><select id="pseg"><option value="">All segments</option>${['NEW', 'REGULAR', 'HIGH_SPENDER', 'AT_RISK', 'DORMANT'].map((x) => `<option ${x === pSeg ? 'selected' : ''}>${x}</option>`).join('')}</select></div><div style="flex:0"><button id="pqBtn">Search</button></div></div></div>
  <div class="panel"><table><tr><th>Name</th><th>Type</th><th>Segment</th><th>Mobile</th><th>City</th><th class="num">Balance</th><th class="num">Lifetime</th><th>Last scan</th><th>Status</th><th></th></tr>
  ${participants.map((p) => `<tr><td>${esc(p.name || '—')}${p.dnd ? ' <span class="muted">· DND</span>' : ''}${p.wa_opt_out ? ' <span class="muted">· STOP</span>' : ''}</td><td>${esc(p.type)}</td><td>${p.segment ? `<span class="seg ${p.segment}">${p.segment.replace('_', ' ')}</span>` : '—'}</td><td>${esc(p.mobile)}</td><td>${esc(p.city || '—')}</td>
    <td class="num">${num(p.balance)}</td><td class="num">${num(p.lifetime_earned)}</td><td>${dt(p.last_scan_at)}</td>
    <td>${p.status === 'ACTIVE' ? '<span class="pill ok">Active</span>' : '<span class="pill bad">Blocked</span>'}</td>
    <td><button class="sm ${p.status === 'ACTIVE' ? 'danger' : ''}" data-block="${p.id}" data-status="${p.status}">${p.status === 'ACTIVE' ? 'Block' : 'Unblock'}</button>
        <button class="sm" data-adj="${p.id}">± Points</button></td></tr>`).join('')}</table></div>`;
  $('pqBtn').onclick = () => { pQuery = $('pq').value; pSeg = $('pseg').value; render(); };
  $('pseg').onchange = () => $('pqBtn').click();
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
    ${f('dailyScanLimit', 'Scans per person per day')}${f('burstScanLimit', 'Scans allowed per minute')}${f('invalidScanLimitPerHour', 'Invalid scans before pause')}${f('maxParticipantsPerDevice', 'Accounts per phone')}</div><div class="row">
    ${f('pointsExpiryMonths', 'Points expire after (months, 0 = never)')}${f('segAtRiskDays', 'At risk after (days idle)')}${f('segDormantDays', 'Dormant after (days idle)')}${f('segHighValuePoints90d', 'High spender: points in 90 days')}</div><div class="row">
    ${f('callHoursStart', 'Calls from (hour, IST)')}${f('callHoursEnd', 'Calls until (hour, IST)')}${f('callCooldownDays', 'Days between calls to one person')}${f('waCampaignDailyCap', 'Campaign messages per day')}</div>
    <button class="p" style="margin-top:14px" id="saveSet">Save</button><div class="err" id="setErr"></div></div>`;
  $('saveSet').onclick = async () => {
    const settings = {}; document.querySelectorAll('[data-set]').forEach((i) => { settings[i.dataset.set] = Number(i.value); });
    try { await api('/api/admin/tenant', { method: 'PATCH', body: { settings } }); $('setErr').textContent = 'Saved ✓'; } catch (e) { $('setErr').textContent = e.message; }
  };
};

boot().catch(() => logout());

// ================= Phase 2 =================
const PT = ['DEALER', 'DISTRIBUTOR', 'RETAILER', 'MECHANIC', 'ELECTRICIAN', 'PLUMBER', 'CONTRACTOR', 'PAINTER', 'CARPENTER'];
const istInput = (d) => new Date(new Date(d).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);

// ---------- Schemes ----------
views.schemes = async () => {
  const [{ schemes }, { products }] = await Promise.all([api('/api/admin/schemes'), api('/api/admin/products')]);
  const today = istInput(Date.now());
  const pill = (s) => ({ ACTIVE: 'ok', DRAFT: 'warn', SETTLED: '', CANCELLED: 'bad' }[s] ?? '');
  const desc = (s) => s.type === 'SCAN_MULTIPLIER' ? `${Number(s.multiplier)}x points per scan`
    : s.slabs.map((x) => `${x.label ? `${esc(x.label)}: ` : ''}${s.metric === 'AMOUNT' ? '₹' : ''}${num(x.min)}${s.metric === 'SCANS' ? ' scans' : s.metric === 'QUANTITY' ? ' units' : ''} → ${x.rewardType === 'PERCENT' ? `${x.value}%` : x.rewardType === 'PER_UNIT' ? `${x.value}/unit` : `${num(x.value)} pts`}`).join(' · ');
  $('main').innerHTML = `<h2>Schemes</h2>
  <div class="panel"><h3>New scheme</h3>
    <div class="row">
      <div><label>Name</label><input id="sName" placeholder="Diwali Dhamaka"></div>
      <div><label>Type</label><select id="sType"><option value="PURCHASE_SLAB">Dealer purchase slabs</option><option value="SCAN_TARGET">Scan target (mechanics)</option><option value="SCAN_MULTIPLIER">Scan multiplier (2x, 3x…)</option></select></div>
      <div><label>Measure</label><select id="sMetric"></select></div>
      <div><label>Start</label><input type="date" id="sStart" value="${today}"></div><div><label>End (last day)</label><input type="date" id="sEnd"></div>
    </div>
    <div class="row">
      <div><label>Who can join</label><select id="sTypes" multiple size="3">${PT.map((t) => `<option>${t}</option>`).join('')}</select><div class="muted">None selected = everyone</div></div>
      <div><label>Products</label><select id="sProds" multiple size="3">${products.map((p) => `<option value="${p.id}">${esc(p.sku)} — ${esc(p.name)}</option>`).join('')}</select><div class="muted">None selected = all products</div></div>
      <div><label>Description (shown on WhatsApp)</label><textarea id="sDesc" rows="3"></textarea></div>
    </div>
    <div id="slabBox"><label>Slabs — highest slab reached wins</label><div id="slabs"></div><button class="sm" id="addSlab" style="margin-top:8px">+ Add slab</button></div>
    <div id="multBox" class="hidden"><label>Multiplier</label><input id="sMult" type="number" step="0.5" min="1.5" value="2" style="max-width:160px"></div>
    <div style="margin-top:14px"><button class="p" id="sSave">Create &amp; activate</button> <button id="sDraft">Save as draft</button></div><div class="err" id="sErr"></div>
  </div>
  <div class="panel"><table><tr><th>Scheme</th><th>Type</th><th>Period</th><th>Rules</th><th>Status</th><th class="num">Winners</th><th class="num">Paid pts</th><th></th></tr>
  ${schemes.map((s) => `<tr><td><b>${esc(s.name)}</b><div class="muted">${esc(s.description || '')}</div></td><td>${esc(s.type.replace('_', ' '))}<div class="muted">${esc(s.metric)}</div></td>
    <td>${istInput(s.starts_at)} → ${istInput(new Date(s.ends_at).getTime() - 1000)}</td><td class="muted">${desc(s)}</td><td><span class="pill ${pill(s.status)}">${s.status}</span></td>
    <td class="num">${num(s.winners)}</td><td class="num">${num(s.paid_points)}</td>
    <td style="white-space:nowrap">${s.type !== 'SCAN_MULTIPLIER' ? `<button class="sm" data-lb="${s.id}">Leaderboard</button>` : ''}
      ${s.status === 'DRAFT' ? `<button class="sm p" data-act="${s.id}">Activate</button>` : ''}
      ${s.status === 'ACTIVE' && s.type !== 'SCAN_MULTIPLIER' && new Date(s.ends_at) < new Date() ? `<button class="sm p" data-settle="${s.id}">Settle now</button>` : ''}
      ${['DRAFT', 'ACTIVE'].includes(s.status) ? `<button class="sm danger" data-cancel="${s.id}">Cancel</button>` : ''}</td></tr>`).join('')}</table></div>
  <div id="lbBox"></div>`;
  const metrics = { PURCHASE_SLAB: [['AMOUNT', 'Purchase value (₹)'], ['QUANTITY', 'Quantity (units)']], SCAN_TARGET: [['SCANS', 'Number of scans']], SCAN_MULTIPLIER: [['SCANS', 'Each scan']] };
  const addSlab = (v = {}) => {
    const d = document.createElement('div'); d.className = 'slabrow';
    d.innerHTML = `<input placeholder="Label (Silver)" data-k="label" value="${esc(v.label || '')}"><input type="number" placeholder="Minimum" data-k="min" value="${v.min || ''}">
      <select data-k="rewardType"><option value="FIXED_POINTS">Fixed points</option><option value="PERCENT">% of purchase</option><option value="PER_UNIT">Points per unit</option></select>
      <input type="number" step="0.01" placeholder="Value" data-k="value" value="${v.value || ''}"><button class="sm danger">✕</button>`;
    d.querySelector('button').onclick = () => d.remove(); $('slabs').appendChild(d);
  };
  const onType = () => {
    const t = $('sType').value;
    $('sMetric').innerHTML = metrics[t].map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    $('slabBox').classList.toggle('hidden', t === 'SCAN_MULTIPLIER'); $('multBox').classList.toggle('hidden', t !== 'SCAN_MULTIPLIER');
  };
  $('sType').onchange = onType; onType(); addSlab({ label: 'Silver' }); addSlab({ label: 'Gold' });
  $('addSlab').onclick = () => addSlab();
  const save = async (status) => {
    $('sErr').textContent = '';
    try {
      const sel = (id) => [...$(id).selectedOptions].map((o) => o.value);
      const slabs = [...document.querySelectorAll('.slabrow')].map((r) => { const o = {}; r.querySelectorAll('[data-k]').forEach((i) => { o[i.dataset.k] = ['min', 'value'].includes(i.dataset.k) ? Number(i.value) : i.value || undefined; }); return o; }).filter((x) => x.min);
      if (!$('sEnd').value) throw new Error('Pick an end date');
      const body = {
        name: $('sName').value, description: $('sDesc').value || undefined, type: $('sType').value, metric: $('sMetric').value,
        startsAt: `${$('sStart').value}T00:00:00+05:30`, endsAt: new Date(new Date(`${$('sEnd').value}T00:00:00+05:30`).getTime() + 86400e3).toISOString(),
        eligibleTypes: sel('sTypes'), productIds: sel('sProds'), status,
        ...($('sType').value === 'SCAN_MULTIPLIER' ? { multiplier: Number($('sMult').value) } : { slabs }),
      };
      await api('/api/admin/schemes', { method: 'POST', body }); render();
    } catch (e) { $('sErr').textContent = e.message; }
  };
  $('sSave').onclick = () => save('ACTIVE'); $('sDraft').onclick = () => save('DRAFT');
  document.querySelectorAll('[data-act]').forEach((b) => b.onclick = async () => { await api(`/api/admin/schemes/${b.dataset.act}/activate`, { method: 'POST' }); render(); });
  document.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = async () => { if (confirm('Cancel this scheme? No bonus will be paid.')) { await api(`/api/admin/schemes/${b.dataset.cancel}/cancel`, { method: 'POST' }); render(); } });
  document.querySelectorAll('[data-settle]').forEach((b) => b.onclick = async () => {
    if (!confirm('Pay out bonuses now? Late invoices after this will not count.')) return;
    try { const r = await api(`/api/admin/schemes/${b.dataset.settle}/settle`, { method: 'POST', body: { force: true } }); alert(`Settled: ${r.winners} winners, ${num(r.paid)} points paid`); } catch (e) { alert(e.message); }
    render();
  });
  document.querySelectorAll('[data-lb]').forEach((b) => b.onclick = async () => {
    const { scheme, rows, totals } = await api(`/api/admin/schemes/${b.dataset.lb}/leaderboard`);
    const unit = (v) => (scheme.metric === 'AMOUNT' ? `₹${num(v)}` : num(v));
    $('lbBox').innerHTML = `<div class="panel"><h3>${esc(scheme.name)} — leaderboard</h3><p class="muted">${num(totals.participants)} taking part · ${num(totals.qualified)} reached a slab · ${num(totals.projectedPoints)} points ${scheme.status === 'SETTLED' ? 'paid' : 'if settled today'}</p>
      <table><tr><th>#</th><th>Name</th><th>Type</th><th>City</th><th class="num">Achieved</th><th>Slab</th><th class="num">Bonus pts</th><th class="num">To next slab</th></tr>
      ${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.participant?.name || '—')}</td><td>${esc(r.participant?.type || '')}</td><td>${esc(r.participant?.city || '')}</td><td class="num">${unit(r.value)}</td>
        <td>${r.slab ? `<span class="pill ok">${esc(r.slab.label || `≥ ${unit(r.slab.min)}`)}</span>` : '—'}</td><td class="num">${num(r.points)}</td><td class="num">${r.nextSlab ? unit(r.remainingToNext) : '🏆'}</td></tr>`).join('')}</table></div>`;
    $('lbBox').scrollIntoView({ behavior: 'smooth' });
  });
};

// ---------- Invoices ----------
let iStatus = 'UNMATCHED';
views.invoices = async () => {
  const [{ invoices }, { participants }] = await Promise.all([api(`/api/admin/invoices?status=${iStatus}&limit=300`), api('/api/admin/participants?limit=500')]);
  const dealers = participants.filter((p) => ['DEALER', 'DISTRIBUTOR', 'RETAILER'].includes(p.type));
  $('main').innerHTML = `<h2>Invoices</h2>
  <div class="panel"><div class="row"><div style="flex:0;min-width:200px"><select id="is">${['UNMATCHED', 'PROCESSED', 'IGNORED'].map((s) => `<option ${s === iStatus ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
    <div class="muted">${iStatus === 'UNMATCHED' ? 'These came from your accounting software but we could not tell which dealer they belong to. Map once — future invoices for that party match automatically.' : ''}</div></div></div>
  <div class="panel"><table><tr><th>Date</th><th>Source</th><th>Doc</th><th>Party (as in accounts)</th><th class="num">Value</th><th>${iStatus === 'UNMATCHED' ? 'Map to dealer' : 'Dealer'}</th><th class="num">Points</th></tr>
  ${invoices.map((i) => `<tr><td>${esc(i.invoice_date)}</td><td>${esc(i.connector_name || i.source)}</td>
    <td>${i.doc_type === 'CREDIT_NOTE' ? '<span class="pill bad">Return</span> ' : ''}${esc(i.voucher_number || i.external_id)}${Number(i.unknown_items) ? `<div class="muted">${i.unknown_items} item(s) not matched to a product</div>` : ''}</td>
    <td>${esc(i.party_name || '—')}<div class="muted">${esc([i.party_ref, i.party_gstin, i.party_mobile].filter(Boolean).join(' · '))}</div></td><td class="num">${inr(i.total_paise)}</td>
    <td>${iStatus === 'UNMATCHED' ? `<select data-map="${i.id}"><option value="">Choose dealer…</option>${dealers.map((d) => `<option value="${d.id}">${esc(d.name || d.mobile)} · ${esc(d.city || '')}</option>`).join('')}</select> <button class="sm" data-ign="${i.id}">Ignore</button>` : esc(i.participant_name || '—')}</td>
    <td class="num">${num(i.base_points)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Nothing here.</td></tr>'}</table></div>`;
  $('is').onchange = () => { iStatus = $('is').value; render(); };
  document.querySelectorAll('[data-map]').forEach((s) => s.onchange = async () => {
    if (!s.value) return;
    try { const r = await api(`/api/admin/invoices/${s.dataset.map}/assign`, { method: 'POST', body: { participantId: s.value } }); alert(`Done: ${r.points} points${r.alsoProcessed ? `, and ${r.alsoProcessed} more invoice(s) of this party matched` : ''}`); } catch (e) { alert(e.message); }
    render();
  });
  document.querySelectorAll('[data-ign]').forEach((b) => b.onclick = async () => { await api(`/api/admin/invoices/${b.dataset.ign}/ignore`, { method: 'POST' }); render(); });
};

// ---------- Connectors ----------
const CTYPES = { TALLY: 'Tally (Prime / ERP 9)', ZOHO_BOOKS: 'Zoho Books', BUSY: 'Busy', MARG: 'Marg', CSV: 'Excel / CSV (any software)', ROYAL: 'Korvo (Royal) DMS', GENERIC: 'Custom software (REST API)' };
views.connectors = async () => {
  const { connectors, endpoints } = await api('/api/admin/connectors');
  $('main').innerHTML = `<h2>Connectors</h2>
  <div class="panel"><h3>Connect accounting / DMS software</h3>
    <p class="muted">Works with any software. Invoices and returns become dealer points and count towards purchase schemes. Use <b>one</b> purchase source per brand (e.g. Royal <i>or</i> Tally) so the same sale is not counted twice.</p>
    <div class="row"><div><label>Software</label><select id="cType">${Object.entries(CTYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      <div><label>Name</label><input id="cName" placeholder="Tally – Ludhiana office"></div>
      <div style="flex:0"><button class="p" id="cAdd">Create</button></div></div><div id="cOut"></div><div class="err" id="cErr"></div></div>
  <div class="panel"><table><tr><th>Name</th><th>Software</th><th>Key</th><th class="num">Documents</th><th class="num">Unmatched</th><th>Last received</th><th>Status</th><th></th></tr>
  ${connectors.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(CTYPES[c.type])}</td><td><code>${esc(c.keyPrefix)}…</code></td><td class="num">${num(c.documents)}</td><td class="num">${num(c.unmatched)}</td>
    <td>${dt(c.lastReceivedAt)}</td><td>${c.status === 'ACTIVE' ? '<span class="pill ok">Active</span>' : '<span class="pill">Disabled</span>'}</td>
    <td style="white-space:nowrap"><button class="sm" data-up="${c.id}" data-type="${c.type}">Upload file</button> <button class="sm" data-rot="${c.id}">New key</button> <button class="sm ${c.status === 'ACTIVE' ? 'danger' : ''}" data-tog="${c.id}" data-st="${c.status}">${c.status === 'ACTIVE' ? 'Disable' : 'Enable'}</button></td></tr>`).join('')}</table>
    <input type="file" id="upFile" class="hidden" accept=".csv,.xml,.json,.txt"></div>
  <div class="panel"><h3>How to send data</h3>
    <p>Header on every request: <code>X-Api-Key: lvx_…</code></p>
    <table><tr><td>Invoices &amp; returns</td><td><code>POST ${esc(endpoints.invoices)}</code></td></tr><tr><td>Dealer master</td><td><code>POST ${esc(endpoints.parties)}</code></td></tr>
      <tr><td>Royal order webhook</td><td><code>POST ${esc(endpoints.royal)}</code></td></tr><tr><td>Test connection</td><td><code>GET ${esc(endpoints.ping)}</code></td></tr></table>
    <p class="muted" style="margin-top:12px"><b>Tally:</b> point the existing Tally connector (TDL) at the invoices URL. It accepts the line-level JSON (<code>vchguid, ledgerguid, itemsku, quantity, amount</code>) or a Tally XML voucher export.
    <b>Zoho Books:</b> add a webhook on invoice/credit-note create. <b>Busy / Marg / Vyapar / Excel:</b> export a sales register CSV and use "Upload file" or POST it with <code>Content-Type: text/csv</code>.
    <b>Any other software:</b> POST JSON in the generic format below.</p>
    <pre>{ "documents": [{ "externalId": "INV-1001", "docType": "INVOICE", "date": "2026-11-02",
    "party": { "ref": "CUST-17", "gstin": "03ABCDE1234F1Z5", "mobile": "9876543210", "name": "Gill Auto Store" },
    "lines": [{ "sku": "BRK-01", "qty": 100, "amount": 50000 }] }] }</pre></div>`;
  $('cAdd').onclick = async () => {
    try {
      const r = await api('/api/admin/connectors', { method: 'POST', body: { type: $('cType').value, name: $('cName').value || CTYPES[$('cType').value] } });
      $('cOut').innerHTML = `<p style="margin-top:14px"><b>API key — copy it now, it will not be shown again:</b></p><div class="key">${esc(r.apiKey)}</div>`;
    } catch (e) { $('cErr').textContent = e.message; }
  };
  document.querySelectorAll('[data-rot]').forEach((b) => b.onclick = async () => {
    if (!confirm('Create a new key? The old key stops working immediately.')) return;
    const r = await api(`/api/admin/connectors/${b.dataset.rot}/rotate-key`, { method: 'POST' });
    $('cOut').innerHTML = `<p style="margin-top:14px"><b>New API key — copy it now:</b></p><div class="key">${esc(r.apiKey)}</div>`;
  });
  document.querySelectorAll('[data-tog]').forEach((b) => b.onclick = async () => { await api(`/api/admin/connectors/${b.dataset.tog}`, { method: 'PATCH', body: { status: b.dataset.st === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' } }); render(); });
  let upId = null;
  document.querySelectorAll('[data-up]').forEach((b) => b.onclick = () => { upId = b.dataset.up; $('upFile').click(); });
  $('upFile').onchange = async () => {
    const f = $('upFile').files[0]; if (!f) return;
    try {
      const r = await api(`/api/admin/connectors/${upId}/upload`, { method: 'POST', body: { content: await f.text() } });
      alert(`${r.received} documents: ${r.created} new, ${r.duplicates} already had, ${r.processed} matched, ${r.unmatched} need mapping.\nPoints: +${r.pointsAwarded} / −${r.pointsReversed}`);
    } catch (e) { alert(e.message); }
    $('upFile').value = ''; render();
  };
};

// ---------- WhatsApp ----------
views.whatsapp = async () => {
  const [{ channel, webhookUrl, sendMode }, { messages }] = await Promise.all([api('/api/admin/channels/whatsapp'), api('/api/admin/messages')]);
  $('main').innerHTML = `<h2>WhatsApp</h2>
  <div class="grid2">
    <div class="panel"><h3>Number</h3>
      ${channel ? `<p><span class="pill ok">Connected</span> ${esc(channel.display_number || channel.phone_number_id)}</p>` : '<p><span class="pill warn">Not connected</span></p>'}
      <p class="muted">Mode: <b>${esc(sendMode)}</b>${sendMode === 'mock' ? ' — replies are saved here, not sent. Set WHATSAPP_SEND_MODE=live after Meta approval.' : ''}</p>
      <label>Phone number ID (Meta)</label><input id="wPn" value="${esc(channel?.phone_number_id || '')}">
      <label>Display number</label><input id="wDn" value="${esc(channel?.display_number || '')}">
      <label>Permanent access token ${channel?.has_token ? '(saved — leave empty to keep)' : ''}</label><input id="wTok" type="password">
      <label>OTP template name (Authentication)</label><input id="wOtp" value="${esc(channel?.config?.otpTemplate?.name || '')}">
      <button class="p" id="wSave" style="margin-top:12px">Save</button><div class="err" id="wErr"></div>
      <p class="muted" style="margin-top:12px">Webhook URL for Meta: <code>${esc(webhookUrl)}</code></p></div>
    <div class="panel"><h3>Try the bot</h3><p class="muted">Type as a dealer or mechanic would (points, 2, scheme, a product code…).</p>
      <div class="row"><div><input id="sFrom" placeholder="Their mobile number"></div></div>
      <div class="chat" id="chat" style="margin-top:10px"></div>
      <div class="row" style="margin-top:8px"><div><input id="sText" placeholder="Message"></div><div style="flex:0"><button class="p" id="sSend">Send</button></div></div></div>
  </div>
  <div class="panel"><h3>Recent messages</h3><table><tr><th>When</th><th>Who</th><th></th><th>Message</th><th>Status</th></tr>
    ${messages.slice(0, 60).map((m) => `<tr><td>${dt(m.created_at)}</td><td>${esc(m.participant_name || m.peer)}</td><td>${m.direction === 'IN' ? '⬅️' : '➡️'}</td><td style="white-space:pre-wrap;max-width:520px">${esc((m.body || '').slice(0, 300))}</td><td><span class="pill ${m.status === 'FAILED' ? 'bad' : ''}">${esc(m.status)}</span>${m.error ? `<div class="muted">${esc(m.error)}</div>` : ''}</td></tr>`).join('')}</table></div>`;
  $('wSave').onclick = async () => {
    try {
      await api('/api/admin/channels/whatsapp', { method: 'PUT', body: { phoneNumberId: $('wPn').value.trim(), displayNumber: $('wDn').value || undefined, accessToken: $('wTok').value || undefined, otpTemplate: $('wOtp').value ? { name: $('wOtp').value } : undefined } });
      render();
    } catch (e) { $('wErr').textContent = e.message; }
  };
  const bub = (t, cls) => { const d = document.createElement('div'); d.className = `bub ${cls}`; d.textContent = t; $('chat').appendChild(d); $('chat').scrollTop = 1e9; };
  $('sSend').onclick = async () => {
    const text = $('sText').value.trim(); if (!text || !$('sFrom').value) return;
    bub(text, 'in'); $('sText').value = '';
    try { const r = await api('/api/admin/whatsapp/simulate', { method: 'POST', body: { from: $('sFrom').value, text } }); bub(r.reply, 'out'); } catch (e) { bub(`(${e.message})`, 'out'); }
  };
  $('sText').addEventListener('keydown', (e) => e.key === 'Enter' && $('sSend').click());
};

// ================= Phase 3 =================
const SEGS = ['NEW', 'REGULAR', 'HIGH_SPENDER', 'AT_RISK', 'DORMANT'];
const SEG_HELP = { NEW: 'Joined in the last 2 weeks', REGULAR: 'Active recently', HIGH_SPENDER: 'Active and earning a lot', AT_RISK: 'Gone quiet — act now', DORMANT: 'Inactive for 45+ days' };
const segPill = (x) => (x ? `<span class="seg ${x}">${x.replace('_', ' ')}</span>` : '—');
const multi = (id, opts, size = 4) => `<select id="${id}" multiple size="${size}">${opts.map((o) => `<option>${o}</option>`).join('')}</select>`;
const sel = (id) => [...$(id).selectedOptions].map((o) => o.value);

views.segments = async () => {
  const d = await api('/api/admin/segments');
  const total = Object.values(d.bySegment).reduce((a, b) => a + b, 0) || 1;
  $('main').innerHTML = `<h2>Segments</h2>
  <div class="kpis">${SEGS.map((x) => `<div class="kpi"><div class="v">${num(d.bySegment[x] || 0)}</div><div class="l">${segPill(x)} <span style="margin-left:4px">${Math.round(((d.bySegment[x] || 0) / total) * 100)}%</span></div><div class="muted" style="font-size:12px;margin-top:4px">${SEG_HELP[x]}</div></div>`).join('')}</div>
  <div class="panel"><div class="row"><div class="muted">Segments refresh every hour. Dealers are scored on purchases, mechanics and retailers on scans. Thresholds are in Settings.</div><div style="flex:0"><button id="recomp">Refresh now</button></div></div></div>
  <div class="grid2"><div class="panel"><h3>By type</h3><table><tr><th>Type</th>${SEGS.map((x) => `<th class="num">${x.replace('_', ' ')}</th>`).join('')}</tr>
    ${[...new Set(d.byType.map((r) => r.type))].map((t) => `<tr><td>${esc(t)}</td>${SEGS.map((x) => `<td class="num">${num(d.byType.find((r) => r.type === t && r.segment === x)?.n || 0)}</td>`).join('')}</tr>`).join('')}</table></div>
  <div class="panel"><h3>Recent changes</h3><table><tr><th>When</th><th>Who</th><th>Change</th></tr>
    ${d.recentChanges.slice(0, 20).map((c) => `<tr><td>${dt(c.computed_at)}</td><td>${esc(c.name || '—')}<div class="muted">${esc(c.type)} · ${esc(c.city || '')}</div></td><td>${segPill(c.previous)} → ${segPill(c.segment)}</td></tr>`).join('')}</table></div></div>`;
  $('recomp').onclick = async () => { await api('/api/admin/segments/recompute', { method: 'POST', body: {} }); render(); };
};

views.calls = async () => {
  const { campaigns } = await api('/api/admin/call-campaigns');
  $('main').innerHTML = `<h2>AI calls</h2>
  <div class="panel"><h3>New call campaign</h3><p class="muted">Calls go out through WayneRing in Hindi, Punjabi or English, only during calling hours, never to DND numbers, and at most once a week per person. Calls never change points.</p>
    <div class="row"><div><label>Name</label><input id="cName" placeholder="Win back dormant mechanics"></div>
      <div><label>Script</label><select id="cScript"><option value="WINBACK">Win back (why did you stop?)</option><option value="SCHEME_REMINDER">Scheme reminder</option><option value="FEEDBACK">Feedback</option></select></div>
      <div><label>Language</label><select id="cLang"><option value="hi">Hindi</option><option value="pa">Punjabi</option><option value="en">English</option></select></div>
      <div><label>City (optional)</label><input id="cCity"></div></div>
    <div class="row"><div><label>Segments</label>${multi('cSeg', SEGS, 5)}</div><div><label>Types</label>${multi('cTypes', PT, 5)}</div></div>
    <button class="p" id="cCreate" style="margin-top:12px">Create &amp; launch</button><div class="err" id="cErr"></div></div>
  <div class="panel"><table><tr><th>Campaign</th><th>Audience</th><th>Status</th><th class="num">Calls</th><th>Outcomes</th><th></th></tr>
  ${campaigns.map((c) => `<tr><td><b>${esc(c.name)}</b><div class="muted">${esc(c.script.replace('_', ' '))} · ${esc(c.language)}</div></td>
    <td class="muted">${esc([c.segments.join(', '), c.participant_types.join(', '), c.city].filter(Boolean).join(' · ') || 'Everyone')}</td>
    <td><span class="pill ${c.status === 'COMPLETED' ? 'ok' : c.status === 'RUNNING' ? 'warn' : ''}">${c.status}</span></td>
    <td class="num">${num(c.stats.completed)} / ${num(c.stats.total)}</td>
    <td class="muted">${esc(Object.entries(c.stats.outcomes).map(([k, v]) => `${k.replace('_', ' ').toLowerCase()} ${v}`).join(' · ') || '—')}</td>
    <td><button class="sm" data-calls="${c.id}">Calls</button> ${['DRAFT', 'RUNNING'].includes(c.status) ? `<button class="sm danger" data-ccancel="${c.id}">Cancel</button>` : ''}</td></tr>`).join('')}</table></div><div id="callBox"></div>`;
  $('cCreate').onclick = async () => {
    try {
      const { campaign } = await api('/api/admin/call-campaigns', { method: 'POST', body: { name: $('cName').value, script: $('cScript').value, language: $('cLang').value, city: $('cCity').value || undefined, segments: sel('cSeg'), participantTypes: sel('cTypes') } });
      const r = await api(`/api/admin/call-campaigns/${campaign.id}/launch`, { method: 'POST' });
      alert(`${r.queued} calls queued · skipped: ${r.skipped.dnd} DND, ${r.skipped.cooldown} called this week`);
      await api('/api/admin/call-campaigns/dispatch', { method: 'POST' }); render();
    } catch (e) { $('cErr').textContent = e.message; }
  };
  document.querySelectorAll('[data-ccancel]').forEach((b) => b.onclick = async () => { await api(`/api/admin/call-campaigns/${b.dataset.ccancel}/cancel`, { method: 'POST' }); render(); });
  document.querySelectorAll('[data-calls]').forEach((b) => b.onclick = async () => {
    const { calls } = await api(`/api/admin/call-campaigns/${b.dataset.calls}/calls`);
    $('callBox').innerHTML = `<div class="panel"><h3>Calls</h3><table><tr><th>Who</th><th>Segment</th><th>Status</th><th>Outcome</th><th>Summary</th></tr>
      ${calls.map((k) => `<tr><td>${esc(k.name || '—')}<div class="muted">${esc(k.mobile)} · ${esc(k.city || '')}</div></td><td>${segPill(k.segment)}</td><td>${esc(k.status)}</td><td>${k.outcome ? `<span class="pill ${k.outcome === 'INTERESTED' ? 'ok' : ['WRONG_NUMBER', 'DO_NOT_CALL'].includes(k.outcome) ? 'bad' : ''}">${esc(k.outcome.replace('_', ' '))}</span>` : '—'}</td><td class="muted">${esc(k.summary || '')}</td></tr>`).join('')}</table>
      ${calls[0] ? `<p class="muted" style="margin-top:12px">Opening line: “${esc(calls[0].first_message)}”</p>` : ''}</div>`;
    $('callBox').scrollIntoView({ behavior: 'smooth' });
  });
};

let oStatus = '';
views.orders = async () => {
  const { orders } = await api(`/api/admin/orders${oStatus ? `?status=${oStatus}` : ''}`);
  $('main').innerHTML = `<h2>Orders</h2>
  <div class="panel"><div class="row"><div style="flex:0;min-width:200px"><select id="os"><option value="">All</option>${['PLACED', 'SENT_TO_DMS', 'FAILED', 'CANCELLED'].map((x) => `<option ${x === oStatus ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
  <div class="muted">Dealers order on WhatsApp (send <b>order</b>). Orders go to Korvo for approval; when Korvo delivers them, purchase points are added automatically.</div></div></div>
  <div class="panel"><table><tr><th>Order</th><th>Dealer</th><th>Items</th><th class="num">Value</th><th>Status</th><th>DMS ref</th><th></th></tr>
  ${orders.map((o) => `<tr><td><b>${esc(o.order_no)}</b><div class="muted">${dt(o.placed_at || o.created_at)}</div></td><td>${esc(o.participant_name || '—')}<div class="muted">${esc(o.mobile)} · ${esc(o.city || '')}</div></td>
    <td class="muted">${o.items.map((i) => `${esc(i.name)} × ${i.qty}`).join('<br>')}</td><td class="num">${inr(o.total_paise)}</td>
    <td><span class="pill ${o.status === 'SENT_TO_DMS' ? 'ok' : o.status === 'FAILED' ? 'bad' : o.status === 'PLACED' ? 'warn' : ''}">${esc(o.status.replace(/_/g, ' '))}</span>${o.error ? `<div class="muted">${esc(o.error)}</div>` : ''}</td>
    <td>${esc(o.dms_order_ref || '—')}</td>
    <td>${['FAILED', 'PLACED'].includes(o.status) ? `<button class="sm" data-retry="${o.id}">Retry</button> <button class="sm" data-ack="${o.id}">Mark processed</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No orders yet.</td></tr>'}</table></div>`;
  $('os').onchange = () => { oStatus = $('os').value; render(); };
  document.querySelectorAll('[data-retry]').forEach((b) => b.onclick = async () => { try { await api(`/api/admin/orders/${b.dataset.retry}/retry`, { method: 'POST' }); } catch (e) { alert(e.message); } render(); });
  document.querySelectorAll('[data-ack]').forEach((b) => b.onclick = async () => { const ref = prompt('Your order number for this order:'); if (!ref) return; await api(`/api/admin/orders/${b.dataset.ack}/ack`, { method: 'POST', body: { ref } }); render(); });
};

views.campaigns = async () => {
  const [{ campaigns }, { schemes }] = await Promise.all([api('/api/admin/wa-campaigns'), api('/api/admin/schemes')]);
  $('main').innerHTML = `<h2>WhatsApp campaigns</h2>
  <div class="panel"><h3>New campaign</h3><p class="muted">Uses a template approved in Meta Business Manager. People who sent STOP are never included. Placeholders: <code>{name}</code> <code>{balance}</code> <code>{brand}</code> <code>{scheme_progress}</code> <code>{app_link}</code></p>
    <div class="row"><div><label>Name</label><input id="wName" placeholder="Diwali scheme launch"></div><div><label>Template name (Meta)</label><input id="wTpl" placeholder="scheme_launch_v1"></div><div><label>Language code</label><input id="wLang" value="hi"></div></div>
    <div class="row"><div><label>Template body params, one per line ({{1}}, {{2}}…)</label><textarea id="wParams" rows="3">{name}\n{scheme_progress}</textarea></div><div><label>Preview text (shown in the message log)</label><textarea id="wPrev" rows="3">Namaste {name}! {scheme_progress}</textarea></div></div>
    <div class="row"><div><label>Segments</label>${multi('wSeg', SEGS, 5)}</div><div><label>Types</label>${multi('wTypes', PT, 5)}</div>
      <div><label>Only people in scheme</label><select id="wScheme"><option value="">—</option>${schemes.filter((x) => x.status === 'ACTIVE').map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></div></div>
    <button class="p" id="wCreate" style="margin-top:12px">Create &amp; send</button><div class="err" id="wErr"></div></div>
  <div class="panel"><table><tr><th>Campaign</th><th>Template</th><th>Status</th><th class="num">Queued</th><th class="num">Sent</th><th class="num">Delivered</th><th class="num">Read</th><th class="num">Failed</th><th></th></tr>
  ${campaigns.map((c) => `<tr><td><b>${esc(c.name)}</b><div class="muted">${esc([c.segments.join(', '), c.participant_types.join(', ')].filter(Boolean).join(' · ') || 'Everyone')}</div></td><td><code>${esc(c.template_name)}</code></td>
    <td><span class="pill ${c.status === 'COMPLETED' ? 'ok' : c.status === 'RUNNING' ? 'warn' : ''}">${c.status}</span></td>
    ${['QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED'].map((k) => `<td class="num">${num(c.stats[k] || 0)}</td>`).join('')}
    <td>${['DRAFT', 'RUNNING'].includes(c.status) ? `<button class="sm danger" data-wcancel="${c.id}">Stop</button>` : ''}</td></tr>`).join('')}</table></div>`;
  $('wCreate').onclick = async () => {
    try {
      const { campaign } = await api('/api/admin/wa-campaigns', { method: 'POST', body: { name: $('wName').value, templateName: $('wTpl').value, language: $('wLang').value, params: $('wParams').value.split('\n').map((x) => x.trim()).filter(Boolean), previewText: $('wPrev').value || undefined, segments: sel('wSeg'), participantTypes: sel('wTypes'), schemeId: $('wScheme').value || undefined } });
      const r = await api(`/api/admin/wa-campaigns/${campaign.id}/launch`, { method: 'POST' });
      await api('/api/admin/wa-campaigns/run', { method: 'POST' });
      alert(`${r.queued} recipients · ${r.skipped.optedOut} skipped (sent STOP)`); render();
    } catch (e) { $('wErr').textContent = e.message; }
  };
  document.querySelectorAll('[data-wcancel]').forEach((b) => b.onclick = async () => { await api(`/api/admin/wa-campaigns/${b.dataset.wcancel}/cancel`, { method: 'POST' }); render(); });
};
