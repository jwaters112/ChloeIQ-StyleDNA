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
      // The "inside" round: up to 6 room photos from the homes they loved, one per room type where possible.
      if (b.action === 'inside') {
        if (list.length > 1 && list.filter((t) => now - t < 60000).length > 20) return res.status(429).json({ ok: false });
        const ins = (hits.get('in:' + ip) || []).filter((t) => now - t < 60000); ins.push(now); hits.set('in:' + ip, ins);
        if (ins.length > 4) return res.status(429).json({ ok: false });
        const phototag = require('./_lib/phototag');
        const homes = (Array.isArray(b.homes) ? b.homes : []).slice(0, 5);
        const jobs = [];
        homes.forEach((h) => (Array.isArray(h && h.photos) ? h.photos : []).slice(1, 5).forEach((u) => { if (typeof u === 'string' && /^https:\/\/img\.chime\.me\//.test(u)) jobs.push({ id: String(h.id || ''), k: String(h.k || ''), url: u }); }));
        const reads = await Promise.all(jobs.slice(0, 16).map(async (x) => Object.assign(x, await phototag.readRoom(x.url) || {})));
        const ok = reads.filter((x) => x.good && ['kitchen', 'living', 'dining', 'primary', 'bath', 'office'].includes(x.room));
        const order = ['kitchen', 'living', 'primary', 'bath', 'dining', 'office'], pick = [], used = new Set();
        for (let round = 0; round < 3 && pick.length < 6; round++) order.forEach((room) => { const x = ok.find((y) => y.room === room && !used.has(y.url) && pick.filter((p) => p.id === y.id).length <= round); if (x && pick.length < 6) { used.add(x.url); pick.push(x); } });
        return res.status(200).json({ ok: true, rooms: pick.map((x) => ({ id: x.id, k: x.k, url: x.url, room: x.room, tone: x.tone, feel: x.feel })) });
      }
      // Test site only: sort a spread of real listings' photos by room, to review before running everywhere.
      if (b.action === 'roomsample' && process.env.VERCEL_ENV !== 'production') {
        const roomsLib = require('./_lib/rooms');
        const picks = [];
        const counties = ['Dallas', 'Collin', 'Denton', 'Tarrant', 'Parker', 'Ellis', 'Rockwall', 'Hood'];
        const bands = [',400000', '400000,700000', '700000,1200000', '1200000,'];
        const found = await Promise.all(counties.map((c, i) => idx.search({ price: bands[i % 4], location: { county: [c] }, propertytype: ['Single Family Home'] }, 6, 1 + (b.page || 0))));
        found.forEach((r) => (r ? r.list : []).slice(0, 3).forEach((l) => { if (picks.length < (b.from || 0) + (b.n || 20) && l.pics && l.pics.length > 5) picks.push(l); }));
        const dbg = found.map((r) => r ? r.list.length + ':' + r.list.map((l) => (l.pics || []).length).join('/') : 'null');
        const out = await Promise.all(picks.slice(b.from || 0, (b.from || 0) + (b.n || 20)).map(async (l) => { const why = {}; const r = await roomsLib.sortHome(l.pics, why); return { id: l.id, address: l.address, price: l.price, acres: l.acres, pool: l.pool, n: l.pics.length, rooms: r, why: why.reason, usage: why.usage }; }));
        return res.status(200).json({ ok: true, model: roomsLib.MODEL, dbg, out });
      }
      // Test site only: re-read a spread of pool homes with the current photo reader, without saving.
      if (b.action === 'tagsample' && process.env.VERCEL_ENV !== 'production') {
        const store = require('./_lib/boards'), phototag = require('./_lib/phototag');
        const counties = ['Dallas', 'Collin', 'Denton', 'Tarrant', 'Parker', 'Ellis'];
        const docs = await Promise.all(counties.map((c) => store.readIn('pool', c).catch(() => null)));
        const byK = {}; docs.forEach((d) => ((d && d.doc && d.doc.homes) || []).forEach((h) => { (byK[h.k] = byK[h.k] || []).push(h); }));
        const pick = []; let round = 0;
        while (pick.length < (b.n || 20) && round < 10) { Object.values(byK).forEach((a) => { if (a[round] && pick.length < (b.n || 20)) pick.push(a[Math.floor(Math.random() * a.length)]); }); round++; }
        const out = await Promise.all(pick.map(async (h) => { const why = {}; const now = await phototag.readOne(h.photo, why); return { id: h.id, old: h.k, now, why: why.reason, photo: h.photo.replace('/w600_original_', '/w800_original_'), address: h.address }; }));
        return res.status(200).json({ ok: true, model: phototag.MODEL, out });
      }
    } catch (e) {
      console.error('deck failed', e && e.message);
      return res.status(502).json({ ok: false, error: 'listings_unavailable' });
    }
    return res.status(400).json({ ok: false });
  }

  if (req.query && req.query.cities) {
    const map = await require('./_lib/pool').cities().catch(() => ({}));
    res.setHeader('Cache-Control', Object.keys(map).length ? 'public, max-age=600' : 'no-store');
    return res.status(200).json({ ok: true, cities: map });
  }
  const q = String((req.query && req.query.q) || '');
  const out = await idx.suggest(q);
  res.setHeader('Cache-Control', out.length ? 'public, max-age=300' : 'no-store');
  if (req.query.debug && process.env.VERCEL_ENV !== 'production') return res.status(200).json({ ok: true, list: out, debug: idx.lastError(), find: await idx.findListing(q) });
  return res.status(200).json({ ok: true, list: out });
};
