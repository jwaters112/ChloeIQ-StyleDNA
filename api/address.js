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
      // All of one home's photos for the in-app viewer: sorted by room when we have them, else the listing's own.
      if (b.action === 'gallery') {
        const roomsLib = require('./_lib/rooms'), store = require('./_lib/boards');
        const id = String(b.id || '').replace(/\D/g, '').slice(0, 20);
        const front = /^https:\/\/img\.chime\.me\//.test(String(b.photo || '')) ? String(b.photo) : '';
        const r = (await roomsLib.loadAll().catch(() => ({})))[id];
        const ORDER = [['living', 'Living room'], ['kitchen', 'Kitchen'], ['dining', 'Dining'], ['primary_bed', 'Primary bedroom'], ['primary_bath', 'Primary bath'], ['bed', 'Bedroom'], ['bath', 'Bath'], ['game', 'Game room'], ['office', 'Office'], ['pool', 'Pool'], ['rear', 'Backyard'], ['aerial', 'From above']];
        const out = front ? [{ u: front, t: 'Front' }] : [];
        const seen = new Set(out.map((x) => x.u));
        if (r) ORDER.forEach(([k, t]) => (r[k] || []).forEach((u) => { if (!seen.has(u)) { seen.add(u); out.push({ u, t }); } }));
        else if (/^[A-Za-z]+$/.test(String(b.county || ''))) {
          const cur = await store.readIn('pool', 'pics' + String(b.county).replace(/ county$/i, '')).catch(() => null);
          ((cur && cur.doc && cur.doc.p && cur.doc.p[id]) || []).slice(0, 20).forEach((u) => { if (!seen.has(u)) { seen.add(u); out.push({ u, t: '' }); } });
        }
        if (out.length <= 1 && typeof b.address === 'string' && b.address.length > 8) {
          const r2 = await idx.search({ location: { streetAddress: [b.address.slice(0, 120)] } }, 3).catch(() => null);
          const l = r2 && r2.list.find((x) => x.id === id);
          ((l && l.pics) || []).slice(0, 20).forEach((u) => { if (!seen.has(u)) { seen.add(u); out.push({ u, t: '' }); } });
        }
        res.setHeader('Cache-Control', 'public, max-age=600');
        return res.status(200).json({ ok: true, photos: out });
      }
      if (b.action === 'availability') return res.status(200).json(await deck.availability(b, String(b.k || '')));
      // The "inside" round: up to 6 room photos from the homes they loved, one per room type where possible.
      if (b.action === 'inside') {
        if (list.length > 1 && list.filter((t) => now - t < 60000).length > 20) return res.status(429).json({ ok: false });
        const ins = (hits.get('in:' + ip) || []).filter((t) => now - t < 60000); ins.push(now); hits.set('in:' + ip, ins);
        if (ins.length > 4) return res.status(429).json({ ok: false });
        const phototag = require('./_lib/phototag');
        // Just the look (tone and feel) of rooms already picked from sorted photos.
        if (Array.isArray(b.urls)) {
          const urls = b.urls.filter((u) => typeof u === 'string' && /^https:\/\/img\.chime\.me\//.test(u)).slice(0, 6);
          const reads = await Promise.all(urls.map(async (u) => Object.assign({ url: u }, await phototag.readRoom(u) || {})));
          return res.status(200).json({ ok: true, feel: reads.map((x) => ({ url: x.url, tone: x.tone || '', feel: x.feel || '' })) });
        }
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

  // Short, branded share links: /s/stone-and-steel-farmhouse shows that name in the link preview,
  // then sends people to the quiz with the sharer's referral kept.
  if (req.query && req.query.share) {
    const SUFFIX = [['french-country', 'french'], ['hill-country', 'hillcountry'], ['mid-century', 'midcentury'], ['barndominium', 'barndo'], ['mediterranean', 'mediterranean'],
      ['transitional', 'transitional'], ['traditional', 'traditional'], ['farmhouse', 'farmhouse'], ['craftsman', 'craftsman'], ['colonial', 'colonial'], ['cottage', 'cottage'],
      ['tudor', 'tudor'], ['ranch', 'ranch'], ['modern', 'modern']];
    const slug = String(req.query.share).toLowerCase().replace(/[^a-z-]/g, '').slice(0, 60);
    // New links carry the style code (/s/modern/glass-pavilion); older ones end in the style word.
    const KEYS = SUFFIX.map(([, key]) => key);
    const given = String(req.query.k || '').toLowerCase().replace(/[^a-z]/g, '');
    const hit = SUFFIX.find(([sfx]) => slug === sfx || slug.endsWith('-' + sfx));
    const k = KEYS.includes(given) ? given : hit ? hit[1] : '';
    const words = slug.split('-').filter(Boolean).map((w) => (['and', 'of', 'the'].includes(w) ? w : w[0].toUpperCase() + w.slice(1)));
    const name = k ? 'The ' + words.join(' ').replace(/^The /, '').replace(/Mid Century/, 'Mid-Century') : 'Home StyleDNA';
    const r = String(req.query.r || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
    const go = k ? `/s/${k}.html?m=share${r ? '&r=' + r : ''}` : '/';
    const e = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const title = k ? `My home style: ${name}` : 'Find your home StyleDNA';
    const img = k ? `https://homestyledna.com/s/${k}.png?v=1` : 'https://homestyledna.com/share-card.png?v=4';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(title)} | Home StyleDNA</title>
<meta property="og:type" content="website"><meta property="og:site_name" content="Home StyleDNA"><meta property="og:url" content="https://homestyledna.com/s/${given ? e(given) + '/' : ''}${e(slug)}">
<meta property="og:title" content="${e(title)}"><meta property="og:description" content="Swipe real DFW homes for sale and find your StyleDNA. Free, two minutes.">
<meta property="og:image" content="${e(img)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${e(title)}"><meta name="twitter:image" content="${e(img)}"><meta name="theme-color" content="#030C0D">
<meta http-equiv="refresh" content="0;url=${e(go)}"><style>body{background:#030C0D;color:#A3A7A6;font-family:sans-serif;text-align:center;padding:40vh 20px}a{color:#E0B24D}</style></head>
<body><p><a href="${e(go)}">Take the StyleDNA quiz</a></p><script>location.replace(${JSON.stringify(go)});</script></body></html>`);
  }
  if (req.query && req.query.fields && process.env.VERCEL_ENV !== 'production') {
    if (req.query.cond) {
      // Try search conditions and report the counts, to learn which filter keys the search honors.
      let tries = []; try { tries = JSON.parse(String(req.query.cond)); } catch (e) { return res.status(400).json({ ok: false }); }
      const out = await Promise.all(tries.slice(0, 12).map(async (t) => { const r = await idx.search(Object.assign({ location: { county: ['Collin'] } }, t), 3); return { t, count: r ? r.count : null, sample: r ? r.list.map((l) => [l.beds, l.baths, l.sqft, l.built, l.acres, l.stories, l.hoa]) : null }; }));
      return res.status(200).json({ ok: true, out });
    }
    const raw = await idx.rawSample({ price: '600000,900000', location: { county: ['Collin'] } }, 3);
    return res.status(200).json({ ok: true, listings: (raw || []).map((l) => { const o = Object.assign({}, l); delete o.listingPictures; delete o.detailsDescribe; return o; }) });
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
