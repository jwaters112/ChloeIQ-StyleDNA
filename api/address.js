// Live listing lookups from joshwaters.com's own search.
// GET  ?q=        address autocomplete for the home board (every active listing, as they type)
// POST /api/deck  { action: 'deck', ...criteria }       the quiz's swipe deck of real homes in their areas
//                 { action: 'availability', k, ...criteria }  homes in their top style, or the closest city that has them
const idx = require('./_lib/idx');
const deck = require('./_lib/deck');
const hits = new Map();

module.exports = async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000); list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  if (list.length > 90) return res.status(429).json({ ok: false });

  if (req.method === 'POST') {
    res.setHeader('Cache-Control', 'no-store');
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
    if (!b || typeof b !== 'object') return res.status(400).json({ ok: false });
    try {
      if (b.action === 'deck') return res.status(200).json(await deck.buildDeck(b));
      if (b.action === 'availability') return res.status(200).json(await deck.availability(b, String(b.k || '')));
    } catch (e) {
      console.error('deck failed', e && e.message);
      return res.status(502).json({ ok: false, error: 'listings_unavailable' });
    }
    return res.status(400).json({ ok: false });
  }

  const q = String((req.query && req.query.q) || '');
  const out = await idx.suggest(q);
  res.setHeader('Cache-Control', out.length ? 'public, max-age=300' : 'no-store');
  if (req.query.debug && process.env.VERCEL_ENV !== 'production') return res.status(200).json({ ok: true, list: out, debug: idx.lastError(), find: await idx.findListing(q) });
  return res.status(200).json({ ok: true, list: out });
};
