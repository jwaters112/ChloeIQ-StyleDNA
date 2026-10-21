/* StyleDNA look and theme.
   Look: DCG (default) or The Agency. ?brand=agency or ?brand=dcg sets it; this browser remembers it.
   Theme: light or dark. Follows the phone's setting until someone taps Light / Dark in the footer,
   or a link carries ?theme=light or ?theme=dark; then this browser remembers it.
   Runs in <head> before first paint so the page never flashes the wrong look. */
(function () {
  var r = document.documentElement, b = 'dcg', t = '';
  function get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  var q = {};
  try { q = Object.fromEntries(new URLSearchParams(location.search)); } catch (e) {}

  if (q.brand === 'agency' || q.brand === 'dcg') { b = q.brand; set('sdna_brand', b); }
  else b = get('sdna_brand') === 'agency' ? 'agency' : 'dcg';
  if (q.theme === 'light' || q.theme === 'dark') { t = q.theme; set('sdna_theme', t); }
  else t = get('sdna_theme');
  if (t !== 'light' && t !== 'dark') {
    t = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  if (b === 'agency') {
    r.setAttribute('data-brand', 'agency');
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600&family=Noto+Serif+Display:wght@400;500&family=Roboto:wght@400;500;700&display=swap';
    document.head.appendChild(l);
  }

  var GROUND = { dcg: { dark: '#030C0D', light: '#F5F5F3' }, agency: { dark: '#000000', light: '#F7F8F6' } };
  function paint(theme) {
    r.setAttribute('data-theme', theme);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', GROUND[b][theme]);
    var btns = document.querySelectorAll('[data-set-theme]');
    for (var i = 0; i < btns.length; i++) btns[i].setAttribute('aria-pressed', btns[i].getAttribute('data-set-theme') === theme ? 'true' : 'false');
  }
  paint(t);
  document.addEventListener('DOMContentLoaded', function () { paint(r.getAttribute('data-theme')); });
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-set-theme]') : null;
    if (!el) return;
    var v = el.getAttribute('data-set-theme');
    set('sdna_theme', v); paint(v);
    try { window.va && window.va('event', { name: 'theme_set', data: { theme: v, brand: b } }); } catch (err) {}
  });
})();
