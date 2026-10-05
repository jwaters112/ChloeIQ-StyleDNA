/* StyleDNA on joshwaters.com: a "Save to board" button on every listing page.
   Loaded by one line in Lofty (Settings > Advanced > Custom JavaScript). Everything it adds is
   namespaced "sdna-" and sits above Lofty's own bottom buttons; it never covers the MLS
   disclaimers for long (the sheet closes with a tap or a swipe down). */
(function () {
  if (window.__sdnaSave) return;
  window.__sdnaSave = true;

  var APP = window.__SDNA_APP || 'https://homestyledna.com';
  var API = APP + '/api/board';
  var STORE = 'sdna_conn';

  // ---------- connection to a board (boardId.pid.key) ----------
  function readConn() {
    try { var c = JSON.parse(localStorage.getItem(STORE) || 'null'); return c && c.id && c.key ? c : null; } catch (e) { return null; }
  }
  function saveConn(c) { try { localStorage.setItem(STORE, JSON.stringify(c)); } catch (e) {} }
  // Links from the quiz and the board end in #sdna=<board>.<member>.<key>[.<board name>]
  // Quiz takers without a board carry #sdnl=<Lofty lead id>.<signature> so their browsing still counts.
  var LEAD = 'sdna_lead';
  function readLead() { try { var l = JSON.parse(localStorage.getItem(LEAD) || 'null'); return l && l.id && l.t ? l : null; } catch (e) { return null; } }
  function takeConnFromHash() {
    var h = location.hash || '';
    var m = h.match(/sdna=([A-Za-z0-9]{8,24})\.([A-Za-z0-9]{4,16})\.([A-Za-z0-9]{12,40})(?:\.([^&]*))?/);
    var l = h.match(/sdnl=(\d{6,20})\.([A-Za-z0-9_-]{16})/);
    if (!m && !l) return;
    if (m) saveConn({ id: m[1], pid: m[2], key: m[3], name: m[4] ? decodeURIComponent(m[4]).slice(0, 40) : '' });
    if (l) { try { localStorage.setItem(LEAD, JSON.stringify({ id: l[1], t: l[2] })); } catch (e) {} }
    try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) {}
    linkLead();
  }
  // Both known in this browser: tell the board which Lofty lead this member is (once).
  function linkLead() {
    var c = readConn(), l = readLead();
    if (!c || !l) return;
    var flag = 'sdna_linked_' + c.id + '_' + l.id;
    try { if (localStorage.getItem(flag)) return; } catch (e) {}
    post({ action: 'link-lead', id: c.id, key: c.key, lead: l }).then(function (j) { if (j.ok) { try { localStorage.setItem(flag, '1'); } catch (e) {} } }, function () {});
  }

  // ---------- listing details from the page ----------
  function meta(name) {
    var el = document.querySelector('meta[property="' + name + '"]') || document.querySelector('meta[name="' + name + '"]');
    return el ? (el.getAttribute('content') || '') : '';
  }
  function isListing() { return /\/listing-detail\//.test(location.pathname); }
  function details() {
    var d = { address: '', mls: '', price: '', beds: '', baths: '', sqft: '' };
    var text = meta('og:description') || meta('description') || '';
    var m = text.match(/for sale:\s*([^(]+?)\s*\(MLS\s*#:\s*(\d+)\)/i);
    if (m) { d.address = m[1].trim(); d.mls = m[2]; }
    var p = text.match(/\$\s?([\d,]{5,})/); if (p) d.price = p[1].replace(/,/g, '');
    var b = text.match(/(\d+)\s*beds?/i); if (b) d.beds = b[1];
    var ba = text.match(/(\d+(?:\.\d)?)\s*baths?/i); if (ba) d.baths = ba[1].replace(/\.0$/, '');
    var sq = text.match(/([\d,]{3,})\s*sq\s?ft/i); if (sq) d.sqft = sq[1].replace(/,/g, '');
    if (!d.address) {
      var slug = (location.pathname.match(/listing-detail\/\d+\/([^/?#]+)/) || [])[1];
      if (slug) d.address = decodeURIComponent(slug).replace(/-/g, ' ');
    }
    return d;
  }
  function listingUrl() { return location.origin + location.pathname; }

  // ---------- look ----------
  var css = [
    "@font-face{font-family:'SdnaM';font-weight:500;font-display:swap;src:url(" + APP + "/fonts/montserrat-latin-500-normal.woff2) format('woff2')}",
    "@font-face{font-family:'SdnaM';font-weight:600;font-display:swap;src:url(" + APP + "/fonts/montserrat-latin-600-normal.woff2) format('woff2')}",
    "@font-face{font-family:'SdnaM';font-weight:600;font-style:italic;font-display:swap;src:url(" + APP + "/fonts/montserrat-latin-600-italic.woff2) format('woff2')}",
    ".sdna-root,.sdna-root *{box-sizing:border-box;font-family:'SdnaM',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;letter-spacing:normal;text-transform:none;line-height:1.4}",
    ".sdna-dock{position:fixed;left:50%;transform:translate3d(-50%,0,0);-webkit-backface-visibility:hidden;backface-visibility:hidden;will-change:transform;max-width:calc(100vw - 120px);white-space:nowrap;z-index:2147483000;display:flex;align-items:center;gap:0;background:rgba(3,12,13,.94);border:1px solid rgba(224,178,77,.55);border-radius:999px;box-shadow:0 10px 30px rgba(0,0,0,.35);overflow:hidden;transition:transform .25s ease,opacity .25s ease}",
    ".sdna-dock button{background:none;border:0;color:#F5F5F3;cursor:pointer;display:flex;align-items:center;gap:8px;padding:12px 16px;font-size:15px;font-weight:600}",
    ".sdna-dock button svg{width:18px;height:18px;flex-shrink:0}",
    ".sdna-dock .sdna-save svg{color:#E0B24D}",
    ".sdna-dock .sdna-save.done svg{fill:#E0B24D}",
    ".sdna-dock .sdna-board{border-left:1px solid rgba(163,167,166,.25);padding:12px 14px;color:#A3A7A6}",
    ".sdna-dock.hide{transform:translate3d(-50%,120px,0);visibility:hidden;opacity:0;pointer-events:none}",
    ".sdna-veil{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.45);opacity:0;transition:opacity .25s ease}",
    ".sdna-veil.on{opacity:1}",
    ".sdna-sheet{position:fixed;left:0;right:0;bottom:0;z-index:2147483002;margin:0 auto;max-width:520px;color:#F5F5F3;border-radius:22px 22px 0 0;border-top:1px solid rgba(163,167,166,.3);padding:12px 22px calc(26px + env(safe-area-inset-bottom));background:radial-gradient(ellipse 90% 70% at 0% 0%,#213D37 0%,#0E2926 35%,#030C0D 75%);transform:translateY(105%);transition:transform .32s cubic-bezier(.2,.8,.2,1)}",
    ".sdna-sheet.on{transform:translateY(0)}",
    ".sdna-grab{width:40px;height:4px;border-radius:4px;background:rgba(163,167,166,.4);margin:0 auto 16px}",
    ".sdna-kicker{font-size:11px;font-weight:600;letter-spacing:2px !important;text-transform:uppercase !important;color:#E0B24D;margin:0 0 8px}",
    ".sdna-title{font-size:23px;font-weight:600;font-style:italic;line-height:1.2;margin:0 0 6px;color:#F5F5F3}",
    ".sdna-sub{font-size:15px;color:#A3A7A6;margin:0 0 18px}",
    ".sdna-addr{font-size:16px;font-weight:600;margin:0 0 2px;color:#F5F5F3}",
    ".sdna-meta{font-size:14px;color:#A3A7A6;margin:0 0 18px}",
    ".sdna-say{display:flex;gap:10px;margin:0 0 18px;border-bottom:1px solid rgba(163,167,166,.32)}",
    ".sdna-say input{flex:1;min-width:0;background:none;border:0;color:#F5F5F3;font-size:16px;padding:10px 0;outline:none}",
    ".sdna-say input::placeholder{color:rgba(163,167,166,.6)}",
    ".sdna-say button{background:none;border:0;color:#E0B24D;font-weight:600;font-size:15px;cursor:pointer}",
    ".sdna-btn{display:block;width:100%;text-align:center;text-decoration:none;background:#E0B24D;color:#030C0D !important;border:0;border-radius:999px;padding:15px 18px;font-size:16px;font-weight:600;cursor:pointer;margin:0 0 6px}",
    ".sdna-link{display:block;width:100%;text-align:center;background:none;border:0;color:#A3A7A6 !important;font-size:15px;padding:12px;cursor:pointer;text-decoration:none}",
    ".sdna-brand{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:6px;font-size:12px;color:rgba(163,167,166,.7)}",
    ".sdna-note{font-size:13px;color:#E0B24D;margin:-8px 0 14px;min-height:1px}"
  ].join('');

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" fill="' + (fill || 'none') + '" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
  }
  var HEART = '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>';
  var GRID = '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>';
  function esc(s) { return String(s || '').replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(n) { n = Number(n); return n ? '$' + n.toLocaleString('en-US') : ''; }
  function track(name, data) { try { if (window.gtag) window.gtag('event', name, data || {}); } catch (e) {} }

  var root, host, dock, saved = {};
  function boardUrl(c) { return APP + '/board.html?id=' + encodeURIComponent(c.id); }

  // Keep the dock above Lofty's own fixed bottom bar (Request Showing) instead of covering it.
  function bottomOffset() {
    var lift = 0, h = window.innerHeight;
    var els = document.body ? document.body.querySelectorAll('*') : [];
    for (var i = 0; i < els.length && i < 4000; i++) {
      var el = els[i];
      if (el.id === 'sdna-host') continue;
      var cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
      var r = el.getBoundingClientRect();
      if (r.height > 0 && r.height < h * 0.4 && r.bottom >= h - 4 && r.width > window.innerWidth * 0.5) lift = Math.max(lift, h - r.top);
    }
    return lift;
  }
  function placeDock() {
    if (!dock) return;
    var b = 'calc(' + (bottomOffset() + 16) + 'px + env(safe-area-inset-bottom))';
    if (dock.style.bottom !== b) dock.style.bottom = b;
  }
  var placeTimer = null;
  function placeSoon() { clearTimeout(placeTimer); placeTimer = setTimeout(placeDock, 200); }

  function render() {
    if (!root) {
      // Fonts must be declared on the page itself; everything else lives in a shadow root so
      // the website's styles can't reach in and ours can't leak out.
      var fonts = document.createElement('style');
      fonts.textContent = css.split('}').filter(function (r) { return r.indexOf('@font-face') === 0; }).map(function (r) { return r + '}'; }).join('');
      document.head.appendChild(fonts);
      host = document.createElement('div'); host.id = 'sdna-host';
      host.style.cssText = 'position:fixed;inset:auto;z-index:2147483000;';
      document.body.appendChild(host);
      var shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
      var st = document.createElement('style');
      st.textContent = ':host{all:initial}' + css.split('}').filter(function (r) { return r.trim() && r.indexOf('@font-face') !== 0; }).map(function (r) { return r + '}'; }).join('') +
        '.sdna-root p{margin-left:0;margin-right:0;padding:0}.sdna-root a{text-decoration:none}';
      shadow.appendChild(st);
      root = document.createElement('div'); root.className = 'sdna-root'; shadow.appendChild(root);
    }
    // Exactly one button on the page, built once and updated in place. iPhone Safari can leave a
    // ghost copy behind when a floating element is removed and redrawn, so we never redraw it.
    if (!document.body.contains(host)) document.body.appendChild(host);
    var extra = document.querySelectorAll('#sdna-host');
    for (var i = 0; i < extra.length; i++) if (extra[i] !== host) extra[i].remove();
    var c = readConn();
    var listing = isListing();
    if (!dock) {
      dock = document.createElement('div');
      dock.className = 'sdna-dock hide';
      root.appendChild(dock);
      dock.addEventListener('click', function (e) {
        var cc = readConn();
        if (e.target.closest('.sdna-save')) { cc ? save(cc) : connectSheet(); }
        else if (e.target.closest('.sdna-board') && cc) location.href = boardUrl(cc);
      });
    }
    var url = listingUrl();
    var isSaved = !!saved[url];
    var html = '';
    if (listing) html += '<button class="sdna-save' + (isSaved ? ' done' : '') + '" type="button">' + svg(HEART) + '<span>' + (isSaved ? 'Saved' : (c ? 'Save to board' : 'Save to a home board')) + '</span></button>';
    if (c) html += '<button class="sdna-board" type="button" aria-label="Open my home board">' + svg(GRID) + (listing ? '' : '<span style="color:#F5F5F3">My home board</span>') + '</button>';
    if (dock.__html !== html) { dock.innerHTML = html; dock.__html = html; }
    var show = !!html && !sheet;
    placeDock();
    // Show only once it sits in its final spot.
    if (show) { if (!dock.__placed) { dock.__placed = true; setTimeout(function () { placeDock(); if (!sheet && dock.__html) dock.classList.remove('hide'); }, 300); } else dock.classList.remove('hide'); }
    else dock.classList.add('hide');
  }

  // ---------- sheet ----------
  var veil, sheet;
  function closeSheet() {
    if (!sheet) return;
    sheet.classList.remove('on'); veil.classList.remove('on');
    var s = sheet, v = veil; sheet = veil = null;
    setTimeout(function () { s.remove(); v.remove(); }, 320);
    if (dock && dock.__html) dock.classList.remove('hide');
  }
  function openSheet(inner) {
    closeSheet();
    veil = document.createElement('div'); veil.className = 'sdna-veil';
    sheet = document.createElement('div'); sheet.className = 'sdna-sheet'; sheet.setAttribute('role', 'dialog');
    sheet.innerHTML = '<div class="sdna-grab"></div>' + inner + '<div class="sdna-brand">StyleDNA by Dallas Collective Group</div>';
    root.appendChild(veil); root.appendChild(sheet);
    veil.onclick = closeSheet;
    var y0 = null;
    sheet.addEventListener('touchstart', function (e) { y0 = e.touches[0].clientY; }, { passive: true });
    sheet.addEventListener('touchend', function (e) { if (y0 !== null && e.changedTouches[0].clientY - y0 > 70) closeSheet(); y0 = null; });
    if (dock) dock.classList.add('hide');
    requestAnimationFrame(function () { requestAnimationFrame(function () { veil.classList.add('on'); sheet.classList.add('on'); }); });
    return sheet;
  }

  function post(body) {
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { j.status = r.status; return j; }); });
  }

  function save(c) {
    var url = listingUrl(), d = details();
    var metaLine = [money(d.price), d.beds && d.beds + ' bd', d.baths && d.baths + ' ba', d.sqft && Number(d.sqft).toLocaleString('en-US') + ' sq ft'].filter(Boolean).join(' \u00b7 ');
    var s = openSheet('<p class="sdna-kicker">StyleDNA \u00b7 Home board</p><p class="sdna-title">Saving\u2026</p><p class="sdna-sub">' + esc(c.name || 'Your home board') + '</p>');
    post({ action: 'add-home', id: c.id, key: c.key, url: url, details: d, via: 'save' }).then(function (j) {
      if (!sheet || sheet !== s) return;
      if (j.status === 403 || j.error === 'not_member' || j.error === 'not_found') {
        try { localStorage.removeItem(STORE); } catch (e) {}
        closeSheet(); render(); connectSheet(true); return;
      }
      var already = j.error === 'already_added';
      if (!j.ok && !already) { s.querySelector('.sdna-title').textContent = "Couldn't save that"; s.querySelector('.sdna-sub').textContent = 'Check your connection and try again.'; return; }
      var name = (j.board && j.board.name) || j.boardName || c.name || 'your home board';
      if (c.name !== name) { c.name = name; saveConn(c); }
      saved[url] = j.homeId || true;
      var others = j.board ? j.board.members.filter(function (m) { return m.pid !== c.pid; }).map(function (m) { return m.name; }) : [];
      s.innerHTML = '<div class="sdna-grab"></div>' +
        '<p class="sdna-kicker">StyleDNA \u00b7 Home board</p>' +
        '<p class="sdna-title">' + (already ? 'Already on ' : 'Saved to ') + esc(name) + '</p>' +
        '<p class="sdna-sub">' + (others.length ? esc(others.join(', ')) + (already ? ' can see it too.' : ' will see it.') : 'Invite someone from your board to react together.') + '</p>' +
        '<p class="sdna-addr">' + esc(d.address) + '</p>' + (metaLine ? '<p class="sdna-meta">' + esc(metaLine) + '</p>' : '') +
        '<form class="sdna-say"><input maxlength="300" placeholder="Add a comment for your board"><button type="submit">Post</button></form><p class="sdna-note"></p>' +
        '<a class="sdna-btn" href="' + boardUrl(c) + '">Open my board</a>' +
        '<button class="sdna-link" type="button">Keep browsing</button>' +
        '<div class="sdna-brand">StyleDNA by Dallas Collective Group</div>';
      s.querySelector('.sdna-link').onclick = closeSheet;
      s.querySelector('form').onsubmit = function (e) {
        e.preventDefault();
        var inp = s.querySelector('input'), text = inp.value.trim(), note = s.querySelector('.sdna-note');
        if (!text || !j.homeId) { if (!j.homeId) note.textContent = 'Open your board to comment on this one.'; return; }
        inp.disabled = true;
        post({ action: 'comment', id: c.id, key: c.key, homeId: j.homeId, text: text }).then(function (r) {
          inp.disabled = false;
          if (r.ok) { inp.value = ''; note.textContent = 'Posted to your board.'; } else note.textContent = "Couldn't post that. Try again.";
        }, function () { inp.disabled = false; note.textContent = "Couldn't post that. Try again."; });
      };
      track('sdna_save', { already: already ? 'yes' : 'no' });
      if (!already) send([{ k: 'save', lid: lidFrom(location.pathname), mls: d.mls, a: d.address, p: d.price }]);
      render();
    }, function () {
      if (sheet === s) { s.querySelector('.sdna-title').textContent = "Couldn't save that"; s.querySelector('.sdna-sub').textContent = 'Check your connection and try again.'; }
    });
  }

  function connectSheet(expired) {
    var back = encodeURIComponent(location.href.split('#')[0]);
    openSheet('<p class="sdna-kicker">StyleDNA \u00b7 Home board</p>' +
      '<p class="sdna-title">' + (expired ? 'Reconnect your board' : 'Save homes with StyleDNA') + '</p>' +
      '<p class="sdna-sub">Keep the homes you like on one shared board with the people you\u2019re buying with, and get an alert when a new listing fits your style.</p>' +
      '<a class="sdna-btn" href="' + APP + '/connect.html?return=' + back + '">I have a home board</a>' +
      '<a class="sdna-link" href="' + APP + '/?utm_source=joshwaters&utm_medium=save_button">Take the 60-second StyleDNA quiz</a>');
  }

  // ---------- browsing log (only for people who came in through StyleDNA) ----------
  var TRACK = APP + '/api/track';
  function who() {
    var c = readConn(); if (c) return { board: { id: c.id, key: c.key } };
    var l = readLead(); if (l) return { lead: l };
    return null;
  }
  function send(events, beacon) {
    var w = who(); if (!w) return;
    w.events = events;
    var body = JSON.stringify(w);
    try {
      if (beacon && navigator.sendBeacon) { navigator.sendBeacon(TRACK, new Blob([body], { type: 'text/plain' })); return; }
      fetch(TRACK, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body, keepalive: true }).catch(function () {});
    } catch (e) {}
  }
  function lidFrom(path) { return ((path || '').match(/listing-detail\/(\d+)/) || [])[1] || ''; }
  function slugAddr(path) { var s = ((path || '').match(/listing-detail\/\d+\/([^/?#]+)/) || [])[1]; return s ? decodeURIComponent(s).replace(/-/g, ' ') : ''; }
  function searchSummary() {
    var q = new URLSearchParams(location.search), raw = q.get('condition'), bits = [];
    if (raw) {
      try {
        var c = JSON.parse(raw), loc = c.location || {};
        if (loc.city) bits.push([].concat(loc.city).join(', '));
        if (loc.zipCode) bits.push('ZIP ' + [].concat(loc.zipCode).join(', '));
        if (c.price) bits.push(String(c.price).split(',').map(function (n) { n = Number(n); return !n ? 'any' : n >= 1e6 ? '$' + (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : '$' + Math.round(n / 1000) + 'K'; }).join(' to '));
        if (c.beds || c.bedroom) bits.push((c.beds || c.bedroom) + '+ bd');
        if (c.propertytype) bits.push([].concat(c.propertytype).join(', '));
        if (c.style) bits.push('style ' + [].concat(c.style).slice(0, 2).join(', '));
        if (c.keyword) bits.push('"' + c.keyword + '"');
      } catch (e) { bits.push(raw.slice(0, 80)); }
    }
    return bits.join(' | ') || location.pathname;
  }
  var view = null;
  function endView() {
    if (!view) return;
    var secs = Math.round((Date.now() - view.at) / 1000);
    if (secs >= 3) send([{ k: 'time', v: view.v, s: secs }], true);
    view = null;
  }
  function pageSeen() {
    endView();
    if (!who()) return;
    if (isListing()) {
      var v = Math.random().toString(36).slice(2, 10);
      view = { v: v, at: Date.now() };
      // Lofty swaps pages without reloading, so give the new listing's details a moment to land.
      setTimeout(function () {
        if (!view || view.v !== v) return;
        var d = details();
        send([{ k: 'view', v: v, lid: lidFrom(location.pathname), mls: d.mls, a: d.address, p: d.price }]);
      }, 1500);
    } else if (/condition=|\/listing(\?|$|\/)|\/search/i.test(location.pathname + location.search)) {
      send([{ k: 'search', q: searchSummary() }]);
    }
  }
  function miniToast(text) {
    if (!root) return;
    var t = document.createElement('div');
    t.setAttribute('style', 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#030C0D;color:#F5F5F3;border:1px solid rgba(224,178,77,.55);border-radius:999px;padding:10px 16px;font:600 14px SdnaM,-apple-system,sans-serif;z-index:2147483003;box-shadow:0 10px 30px rgba(0,0,0,.35)');
    t.textContent = text; root.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }
  // Lofty's own heart: log it and put the same home on their StyleDNA board.
  function heartClicked(url) {
    var c = readConn(), lid = lidFrom(url), onPage = lid && lid === lidFrom(location.pathname);
    var d = onPage ? details() : { address: slugAddr(url) };
    send([{ k: 'heart', lid: lid, mls: d.mls, a: d.address, p: d.price }]);
    if (!c || !lid) return;
    var clean = url.split('#')[0].split('?')[0];
    if (saved[clean]) return;
    post({ action: 'add-home', id: c.id, key: c.key, url: clean, via: 'heart', details: onPage ? d : undefined }).then(function (j) {
      if (j.ok || j.error === 'already_added') { saved[clean] = j.homeId || true; miniToast('Also saved to ' + ((j.board && j.board.name) || j.boardName || c.name || 'your home board')); render(); }
    }, function () {});
  }
  function watchClicks() {
    document.addEventListener('click', function (e) {
      var t = e.target; if (!t || !t.closest || t.closest('#sdna-host')) return;
      if (!who()) return;
      var main = t.closest('.save-share-container .item.save');
      if (main && isListing()) { heartClicked(location.href); return; }
      var heart = t.closest('.icon-heart-fill, [class*="favorite" i]');
      if (heart) {
        var card = heart, link = null;
        for (var i = 0; i < 8 && card && !link; i++) { card = card.parentElement; link = card && card.querySelector && card.querySelector('a[href*="listing-detail"]'); }
        if (link) { heartClicked(link.href); return; }
      }
      var btn = t.closest('button, a');
      // joshwaters.com/evaluation: the address they're valuing (their current home).
      if (btn && /\/evaluation/.test(location.pathname) && /next|get|value|estimate/i.test(btn.innerText || '')) {
        var inp = document.querySelector('input[placeholder*="address" i]');
        var addr = inp && inp.value.trim();
        if (addr && addr.length > 5 && addr !== (window.__sdnaVal || '')) { window.__sdnaVal = addr; send([{ k: 'value', a: addr }]); }
      }
      if (btn) {
        var label = (btn.innerText || '').trim();
        if (btn.classList.contains('gotour') || /schedule a (free )?tour|request (a )?showing|book a tour/i.test(label)) send([{ k: 'tour', lid: lidFrom(location.pathname), a: isListing() ? details().address : '' }]);
        else if (/^(contact|ask a question|message|request info)/i.test(label)) send([{ k: 'contact', lid: lidFrom(location.pathname), a: isListing() ? details().address : '' }]);
      }
    }, true);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') endView(); else if (!view && isListing()) pageSeen(); });
    window.addEventListener('pagehide', endView);
  }

  // ---------- start, and follow Lofty's page changes (it doesn't reload between pages) ----------
  function boot() {
    takeConnFromHash();
    render();
    linkLead();
    watchClicks();
    pageSeen();
    var last = location.href;
    setInterval(function () {
      if (location.href !== last) { last = location.href; takeConnFromHash(); closeSheet(); render(); pageSeen(); }
    }, 600);
    window.addEventListener('resize', placeSoon);
    setTimeout(placeDock, 1500); setTimeout(placeDock, 4000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
