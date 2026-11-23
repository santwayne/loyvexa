/*
 * Loopdesk AI top bar for plain-HTML pages (same look as the React LoopdeskHeader in the other tools).
 * Usage: <div id="ldHeader" data-tool="loyvexa" data-logo="/admin/brand/icon-512.png"></div>
 *        <script src="loopdesk-header.js"></script>
 * Then: LoopdeskHeader.setBusiness("Name"); LoopdeskHeader.onLogout(fn);
 * Needs loopdesk.css. Hub address: data-hub on the element, default https://app.loopdeskai.wayneesolutions.com
 */
(function () {
  var el = document.getElementById('ldHeader');
  if (!el) return;
  var HUB = (el.getAttribute('data-hub') || 'https://app.loopdeskai.wayneesolutions.com').replace(/\/$/, '');
  window.LOOPDESK_HUB = HUB; // for "Back to Loopdesk" links in admin.js
  var tool = el.getAttribute('data-tool') || 'home';
  var logo = el.getAttribute('data-logo') || '/brand/icon-512.png';
  var TOOLS = [
    ['home', 'Home', 'Customers, inbox, offers, growth', '/dashboard'],
    ['calls', 'Calls', 'AI phone agent', '/api/hub/open/wayneRing'],
    ['jobs', 'Jobs', 'Field service and staff', '/api/hub/open/field-service'],
    ['google', 'Google Profile', 'Reviews and Google listing', '/api/hub/open/gmb'],
    ['ads', 'Ads', 'AI video ads', '/api/hub/open/video'],
    ['loyvexa', 'Loyvexa', 'Channel loyalty', '/api/hub/open/loyvexa'],
    ['korvo', 'Korvo', 'Distributor app with Tally', '/api/hub/open/korvo']
  ];
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var current = TOOLS.filter(function (t) { return t[0] === tool; })[0] || TOOLS[0];
  el.outerHTML =
    '<header class="ld-header" id="ldHeader"><div class="ld-header-inner"><div class="ld-header-left">' +
    '<a class="ld-wordmark" href="' + HUB + '/dashboard"><span class="ld-logo-tile"><img src="' + esc(logo) + '" alt="" width="30" height="30"></span>Loopdesk AI</a>' +
    (tool !== 'home' ? '<span class="ld-header-sep" aria-hidden="true">/</span><span class="ld-header-tool">' + esc(current[1]) + '</span>' : '') +
    '<div class="ld-switcher-anchor"><button type="button" class="ld-switcher-btn" aria-label="Switch tool" aria-expanded="false">' +
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></button>' +
    '<div class="ld-switcher" role="menu" aria-label="Loopdesk AI tools" hidden><div class="ld-switcher-head">Loopdesk AI</div><div class="ld-switcher-grid">' +
    TOOLS.map(function (t) {
      var cur = t[0] === tool;
      return '<a role="menuitem" class="ld-switcher-item' + (cur ? ' is-current' : '') + '"' + (cur ? ' aria-current="page"' : ' href="' + HUB + t[3] + '"') + '><span class="ld-switcher-name">' + esc(t[1]) + '</span><span class="ld-switcher-blurb">' + esc(t[2]) + '</span></a>';
    }).join('') +
    '</div></div></div></div>' +
    '<div class="ld-header-right"><span class="ld-header-biz" id="ldBiz" hidden></span><button type="button" class="ld-link-btn" id="ldLogout" hidden>Log out</button></div>' +
    '</div></header>';
  var root = document.getElementById('ldHeader');
  var btn = root.querySelector('.ld-switcher-btn');
  var menu = root.querySelector('.ld-switcher');
  var setOpen = function (o) { menu.hidden = !o; btn.setAttribute('aria-expanded', o ? 'true' : 'false'); };
  btn.addEventListener('click', function () { setOpen(menu.hidden); });
  document.addEventListener('mousedown', function (e) { if (!menu.hidden && !root.querySelector('.ld-switcher-anchor').contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
  window.LoopdeskHeader = {
    setBusiness: function (name) { var b = document.getElementById('ldBiz'); b.textContent = name || ''; b.title = name || ''; b.hidden = !name; },
    onLogout: function (fn) { var l = document.getElementById('ldLogout'); l.hidden = !fn; l.onclick = fn; }
  };
})();
