/* StyleDNA look: DCG (default) or The Agency.
   ?brand=agency or ?brand=dcg in any link sets the look and this browser remembers it.
   Runs in <head> before first paint so the page never flashes the other look. */
(function () {
  var r = document.documentElement, b = 'dcg';
  try {
    var q = new URLSearchParams(location.search).get('brand');
    if (q === 'agency' || q === 'dcg') { b = q; localStorage.setItem('sdna_brand', q); }
    else { b = localStorage.getItem('sdna_brand') === 'agency' ? 'agency' : 'dcg'; }
  } catch (e) {}
  if (b !== 'agency') return;
  r.setAttribute('data-brand', 'agency');
  var l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600&family=Noto+Serif+Display:wght@400;500&family=Roboto:wght@400;500;700&display=swap';
  document.head.appendChild(l);
  var m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', '#000000');
  else document.addEventListener('DOMContentLoaded', function () {
    var t = document.querySelector('meta[name="theme-color"]'); if (t) t.setAttribute('content', '#000000');
  });
})();
