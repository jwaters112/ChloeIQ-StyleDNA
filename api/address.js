// Address autocomplete for the home board: every active listing in the MLS, as the person types.
const idx = require('./_lib/idx');
const hits = new Map();

module.exports = async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000); list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  if (list.length > 90) return res.status(429).json({ ok: false });
  const q = String((req.query && req.query.q) || '');
  const out = await idx.suggest(q);
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (req.query.debug && process.env.VERCEL_ENV !== 'production') return res.status(200).json({ ok: true, list: out, debug: idx.lastError(), find: await idx.findListing(q) });
  return res.status(200).json({ ok: true, list: out });
};
