// Builds the swipe deck from real homes for sale in the areas someone picked, scores homes against
// their must-haves, and answers "how many homes in my style are near me, and if none, where?".
const idx = require('./idx');
const { STYLES, BY_KEY, COUNTIES } = require('./styles');
const pool = require('./pool');
const phototag = require('./phototag');
const roomsLib = require('./rooms');

const PRICES = new Set([',300000', '300000,500000', '500000,750000', '750000,1000000', '1000000,']);
const TYPES = new Set(['Single Family Home', 'Townhouse', 'Condo']);
const LEVEL = new Set(['must', 'nice']);
const clip = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

// Whatever the browser sends, keep only values we know.
function criteria(b) {
  b = b || {};
  const counties = (Array.isArray(b.counties) ? b.counties : []).filter((c) => COUNTIES[c]).slice(0, 8);
  const cities = (Array.isArray(b.cities) ? b.cities : []).map((c) => clip(c, 40).replace(/[^A-Za-z .'-]/g, '')).filter(Boolean).slice(0, 12);
  const must = {}, picks = {};
  ['pool', 'acres', 'gameroom', 'suite', 'access'].forEach((k) => { const v = b.must && b.must[k]; if (LEVEL.has(v)) must[k] = v; });
  const allowed = { exterior: ['brick', 'stone', 'stucco', 'siding'], layout: ['open', 'separate'], condition: ['ready', 'updates', 'project'], hoa: ['no', 'yes'], setting: ['near', 'secluded'] };
  Object.entries(allowed).forEach(([k, vals]) => { const v = b.picks && b.picks[k]; if (vals.includes(v)) picks[k] = v; });
  return { counties, cities, price: PRICES.has(b.price) ? b.price : '', type: TYPES.has(b.type) ? b.type : '', must, picks };
}

function baseCond(c, countiesOverride) {
  const cond = {};
  if (c.type) cond.propertytype = [c.type];
  if (c.price) cond.price = c.price;
  const counties = countiesOverride || c.counties;
  if (!countiesOverride && c.cities.length) cond.location = { city: c.cities.map((x) => x + ', TX') };
  else cond.location = { county: counties.length ? counties : Object.keys(COUNTIES) };
  if (c.must.acres === 'must') cond.acres = '1,';
  return cond;
}

// ---- what a listing has, read from the MLS fields and the remarks ----
const has = {
  pool: (l) => l.pool,
  acres: (l) => l.acres >= 1,
  gameroom: (l) => /game ?room|media room|theater|theatre|bonus room/.test(l.remarks),
  suite: (l) => /guest suite|in-law|mother-in-law|casita|guest quarters|guest house|second primary|dual primar|next ?gen|multi-?gen/.test(l.remarks),
  access: (l) => /^(one|1)$/i.test(l.stories) || /single[- ]story|one[- ]story|wheelchair|no[- ]step|wide doorways|accessib/.test(l.remarks),
};
const pickHas = {
  exterior: { brick: (l) => /brick/i.test(l.materials), stone: (l) => /stone|rock/i.test(l.materials), stucco: (l) => /stucco/i.test(l.materials), siding: (l) => /siding|hardi|fiber cement|wood|vinyl/i.test(l.materials) },
  layout: { open: (l) => /open (concept|floor ?plan|layout)/.test(l.remarks), separate: (l) => /formal (dining|living)|separate (dining|living)|private (study|office)/.test(l.remarks) },
  condition: {
    ready: (l) => /move-in ready|turn-?key|updated|remodeled|renovated|new construction|brand new/.test(l.remarks),
    updates: () => true,
    project: (l) => /investor|fixer|needs (work|tlc|updat)|as[- ]is|\btlc\b|bring your (ideas|vision|contractor)|sweat equity/.test(l.remarks),
  },
  hoa: { no: (l) => !l.hoa, yes: (l) => l.hoa },
  setting: {
    near: (l) => /walk(ing)? (distance )?to|steps (from|to)|minutes (from|to)|shopping|restaurants|dining and/.test(l.remarks),
    secluded: (l) => l.acres >= 1 || /secluded|private (lot|setting|retreat)|wooded|tree-?lined|cul-de-sac|peaceful/.test(l.remarks),
  },
};
const FEATURE_LABEL = { pool: 'Pool', acres: '1+ acre', gameroom: 'Game room', suite: 'Guest suite', access: 'One story' };
function fit(l, c) {
  let score = 0; const hits = [];
  Object.entries(c.must).forEach(([k, lvl]) => {
    if (has[k](l)) { score += lvl === 'must' ? 3 : 1; hits.push(FEATURE_LABEL[k]); } else if (lvl === 'must') score -= 2;
  });
  Object.entries(c.picks).forEach(([k, v]) => { if (pickHas[k] && pickHas[k][v] && pickHas[k][v](l)) score += 1; });
  return { score, hits };
}

function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
async function each(tasks, n) {
  const out = new Array(tasks.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => { while (i < tasks.length) { const at = i++; out[at] = await tasks[at](); } }));
  return out;
}
const dist = (a, b) => Math.hypot(a[0] - b[0], (a[1] - b[1]) * 0.84);
function areaCenter(c) {
  const pts = c.counties.map((k) => COUNTIES[k]).filter(Boolean);
  if (!pts.length) return [32.85, -96.95];
  return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
}
function stylesFor(c) {
  // Condos and townhomes don't come as barndominiums or acreage ranches.
  return STYLES.filter((s) => !(c.type && c.type !== 'Single Family Home' && ['barndo', 'hillcountry'].includes(s.k)));
}
const factsLine = (l) => [l.city, l.beds && l.beds + ' bd', l.baths && l.baths + ' ba', l.acres >= 1 ? l.acres.toFixed(1).replace(/\.0$/, '') + ' acres' : '', l.pool ? 'Pool' : ''].filter(Boolean).join(' · ');
// Traits the quiz learns from as people swipe, beyond the style itself.
function traits(l) {
  const m = String(l.materials || '').toLowerCase();
  const mat = /stone|rock/.test(m) ? 'stone' : /stucco/.test(m) ? 'stucco' : /brick/.test(m) ? 'brick' : /siding|hardi|wood|vinyl|cement/.test(m) ? 'siding' : '';
  const st = /^(one|1)$/i.test(String(l.stories || '')) ? 'one' : /two|three|2|3/i.test(String(l.stories || '')) ? 'two' : '';
  const year = new Date().getFullYear();
  return { mat, st, lot: l.acres >= 1 ? 'big' : '', era: l.built ? (l.built >= year - 8 ? 'new' : l.built < 1975 ? 'classic' : 'est') : '', pool: l.pool ? 'yes' : '' };
}
// The photos a swipe card shows, in a set order: the front (its style), living room, kitchen, primary bath,
// then the features they asked for when this home has a photo of them, and an aerial when they want acreage.
// A home without a sorted photo for a slot simply skips it.
const ROOM_LABEL = { living: 'Living room', kitchen: 'Kitchen', primary_bath: 'Primary bath', pool: 'Pool', game: 'Game room', aerial: 'From above' };
function cardPhotos(l, c, rooms) {
  const r = rooms && rooms[l.id];
  if (!r) return { photos: (l.photos || []).slice(0, 5), plabels: [] };
  const slots = ['living', 'kitchen', 'primary_bath'];
  const wants = (k) => c.must[k] === 'must' || c.must[k] === 'nice';
  if (wants('pool')) slots.push('pool');
  if (wants('gameroom')) slots.push('game');
  if (wants('acres')) slots.push('aerial');
  const photos = [l.photo], plabels = ['Front'], used = new Set([l.photo]);
  slots.forEach((k) => { const u = (r[k] || []).find((x) => !used.has(x)); if (u) { used.add(u); photos.push(u); plabels.push(ROOM_LABEL[k]); } });
  // Rooms for the "inside" round at the end of the deck.
  const ins = {}; ['living', 'kitchen', 'primary_bath', 'primary_bed', 'dining'].forEach((k) => { if (r[k] && r[k][0]) ins[k] = r[k][0]; });
  return { photos, plabels, ins };
}
function card(l, s, c, near, rooms) {
  const f = fit(l, c);
  return { id: l.id, k: s.k, label: s.label, desc: s.desc, photo: l.photo, ...cardPhotos(l, c, rooms), url: l.url, address: l.address, city: l.city, county: l.county,
    price: l.price, beds: l.beds, baths: l.baths, sqft: l.sqft, acres: l.acres, pool: l.pool, office: l.office, facts: factsLine(l), hits: f.hits, near: !!near, t: traits(l) };
}

const DECK_SIZE = 20;
const TYPE_RE = { 'Single Family Home': /single family/i, Townhouse: /town/i, Condo: /condo/i };
function inSearch(l, c, cities) {
  if (c.price) { const [lo, hi] = c.price.split(',').map((x) => Number(x) || 0); if ((lo && l.price < lo) || (hi && l.price > hi)) return false; }
  if (c.type && l.ptype && TYPE_RE[c.type] && !TYPE_RE[c.type].test(l.ptype)) return false;
  if (cities && cities.size && !cities.has(String(l.city || '').toLowerCase())) return false;
  if (c.must.acres === 'must' && !(l.acres >= 1)) return false;
  return true;
}
async function buildDeck(input) {
  const c = criteria(input);
  const rooms = await roomsLib.loadAll().catch(() => ({}));
  const styles = stylesFor(c);
  const counties = c.counties.length ? c.counties : Object.keys(COUNTIES);
  const cities = new Set(c.cities.map((x) => x.toLowerCase()));
  const pick = (homes, near) => {
    const cands = {}, seen = new Set();
    homes.forEach((l) => {
      if (seen.has(l.id) || !BY_KEY[l.k] || !styles.some((s) => s.k === l.k)) return; seen.add(l.id);
      (cands[l.k] = cands[l.k] || []).push(Object.assign(card(l, BY_KEY[l.k], c, near, rooms), { _f: fit(l, c).score + Math.random() * 0.6 + (rooms[l.id] ? 0.5 : 0) }));
    });
    Object.values(cands).forEach((a) => a.sort((x, y) => y._f - x._f));
    return cands;
  };
  let homes = (await pool.load(counties)).filter((l) => inSearch(l, c, cities));
  let source = 'pool';
  if (!homes.length && !(await pool.load(counties)).length) {
    // Pool not built for these counties yet: look live, and read photos now (slower, first time only).
    source = 'live';
    const results = await each(styles.map((s) => () => idx.search(Object.assign({}, baseCond(c), s.q), 12)), 6);
    const all = []; results.forEach((r) => (r ? r.list : []).forEach((l) => all.push(l)));
    const tags = await phototag.tagAll(all, 60, 7000);
    homes = all.map((l) => { const t = phototag.parse(tags[l.id]); return t && t.sure ? Object.assign({}, l, { k: t.k }) : null; }).filter(Boolean);
  }
  // Narrow city picks the nightly sample doesn't cover well: look those cities up live and read any new photos now.
  if (source === 'pool' && cities.size && homes.length < DECK_SIZE) {
    const results = await each(styles.map((s) => () => idx.search(Object.assign({}, baseCond(c), s.q), 12)), 6);
    const have = new Set(homes.map((l) => l.id)), fresh = [];
    results.forEach((r) => (r ? r.list : []).forEach((l) => { if (!have.has(l.id)) { have.add(l.id); fresh.push(l); } }));
    if (fresh.length) {
      const tags = await phototag.tagAll(fresh, 40, 5000);
      fresh.forEach((l) => { const t = phototag.parse(tags[l.id]); if (t && t.sure) homes.push(Object.assign({}, l, { k: t.k })); });
    }
  }
  const cands = pick(homes, false);
  const sizes = Object.fromEntries(Object.entries(cands).map(([k, a]) => [k, a.length]));
  let total = homes.length;
  const addNear = (more) => {
    const ids = new Set(Object.values(cands).flat().map((x) => x.id));
    const add = pick(more.filter((l) => !ids.has(l.id)), true);
    Object.entries(add).forEach(([k, a]) => { cands[k] = (cands[k] || []).concat(a); });
    total += Object.values(add).reduce((n, a) => n + a.length, 0);
  };
  // Short of a full deck: the rest of their counties first, then the nearest neighboring counties, marked "Nearby".
  if (total < DECK_SIZE + 4 && source === 'pool' && cities.size) addNear((await pool.load(counties)).filter((l) => inSearch(l, c, null)));
  if (total < DECK_SIZE && source === 'pool') {
    const center = areaCenter(c);
    const extra = Object.keys(COUNTIES).filter((k) => !counties.includes(k)).sort((a, b) => dist(COUNTIES[a], center) - dist(COUNTIES[b], center)).slice(0, 3);
    addNear((await pool.load(extra)).filter((l) => inSearch(l, c, null)));
  }
  // A few "Nearby" probes: styles their area doesn't have, so a surprise love can point them somewhere new.
  const center = areaCenter(c);
  const neighbors = Object.keys(COUNTIES).filter((k) => !counties.includes(k)).sort((a, b) => dist(COUNTIES[a], center) - dist(COUNTIES[b], center)).slice(0, 3);
  const probes = [];
  if (source === 'pool') {
    const around = pick((await pool.load(neighbors)).filter((l) => inSearch(l, c, null)), true);
    shuffle(Object.keys(around).filter((k) => !sizes[k])).slice(0, 3).forEach((k) => { const x = around[k][0]; if (x) probes.push(Object.assign(x, { probe: true })); });
  }
  // The phone picks each next card from these as they swipe (up to 8 per style, best fits first).
  // When only a few styles exist in their area, send more of each so there is still room to learn.
  const nStyles = styles.filter((st) => cands[st.k] && cands[st.k].length).length || 1;
  const per = Math.max(8, Math.ceil(28 / nStyles));
  const cardsOut = [];
  styles.forEach((st) => (cands[st.k] || []).slice(0, per).forEach((x) => cardsOut.push(x)));
  probes.forEach((x) => cardsOut.push(x));
  cardsOut.forEach((x) => { delete x._f; });
  return { ok: true, cards: cardsOut, counts: sizes, total, source, styles: styles.map((s) => ({ k: s.k, label: s.label, desc: s.desc })), criteria: c };
}

// The homes in this style that fit their search, as an exact list they can open one by one.
// Two sources, merged: homes whose photo was read as this style (the nightly pool), and the live
// joshwaters.com search for the style. A live home whose photo was read as a different style is left out.
// Must-haves the site search can't filter on (pool, game room...) are checked on each home's own details.
const LIST_PAGES = 3, PAGE = 100, LIST_MAX = 60;
async function availability(input, k) {
  const c = criteria(input); const s = BY_KEY[k];
  if (!s) return { ok: false };
  const counties = c.counties.length ? c.counties : Object.keys(COUNTIES);
  const cities = new Set(c.cities.map((x) => x.toLowerCase()));
  const cond = Object.assign({}, baseCond(c), s.q);
  const [first, mine, tags] = await Promise.all([idx.search(cond, PAGE, 1), pool.load(counties), phototag.loadAll().catch(() => ({}))]);
  const liveTotal = first ? first.count : 0;
  const pages = [first];
  if (first && liveTotal > PAGE) {
    const more = await Promise.all(Array.from({ length: Math.min(LIST_PAGES, Math.ceil(liveTotal / PAGE)) - 1 }, (_, i) => idx.search(cond, PAGE, i + 2)));
    pages.push(...more);
  }
  const liveList = []; pages.forEach((r) => (r ? r.list : []).forEach((l) => liveList.push(l)));
  const hard = Object.keys(c.must).filter((m) => c.must[m] === 'must' && has[m]);
  const ok = (l) => hard.every((m) => has[m](l));
  const byId = new Map();
  mine.filter((l) => l.k === k && inSearch(l, c, cities)).forEach((l) => byId.set(l.id, l));
  liveList.forEach((l) => {
    if (byId.has(l.id) || !inSearch(l, c, cities)) return;
    const t = phototag.parse(tags[l.id]);
    if (t && t.k !== k) return;
    byId.set(l.id, l);
  });
  const all = [...byId.values()];
  const fits = all.filter(ok);
  // The live search can return more homes than we read; only then is the count an estimate.
  const unread = Math.max(0, liveTotal - liveList.length);
  const est = unread > 0 && hard.length > 0;
  const count = fits.length + (unread ? Math.round(unread * (all.length ? fits.length / all.length : 0)) : 0);
  const homes = fits.map((l) => ({ l, f: fit(l, c) })).sort((a, b) => (b.f.score - a.f.score) || ((a.l.price || 0) - (b.l.price || 0))).slice(0, LIST_MAX).map((x) => card(x.l, s, c));
  const out = { ok: true, k, label: s.label, count, est, homes, listed: homes.length,
    ...(process.env.VERCEL_ENV !== 'production' ? { debug: { pool: mine.length, liveTotal, liveRead: liveList.length, merged: all.length, fits: fits.length } } : {}),
    // For "browse more": the style search on joshwaters.com (it can't filter must-haves, so it's worded as browsing).
    url: idx.searchUrl(cond), areaUrl: idx.searchUrl(baseCond(c)), styled: true };
  if (count < 5) {
    const inArea = mine.filter((l) => inSearch(l, c, cities));
    const all = (await pool.load(Object.keys(COUNTIES))).filter((l) => l.k === k && inSearch(l, c, null) && !cities.has(String(l.city || '').toLowerCase()));
    const pts = inArea.filter((l) => l.lat && l.lng);
    const center = pts.length ? [pts.reduce((t, l) => t + l.lat, 0) / pts.length, pts.reduce((t, l) => t + l.lng, 0) / pts.length] : areaCenter(c);
    const byCity = {};
    all.forEach((l) => { if (!l.city || !l.lat) return; const b = byCity[l.city] = byCity[l.city] || { city: l.city, county: l.county, n: 0, lat: 0, lng: 0 }; b.n++; b.lat += l.lat; b.lng += l.lng; });
    const best = Object.values(byCity).map((b) => Object.assign(b, { d: dist([b.lat / b.n, b.lng / b.n], center) - Math.min(b.n, 4) * 0.01 })).sort((a, b) => a.d - b.d)[0];
    if (best) out.nearest = { city: best.city, county: best.county, n: best.n, url: idx.searchUrl(baseCond(Object.assign({}, c, { cities: [best.city] }))) };
  }
  return out;
}

module.exports = { criteria, buildDeck, availability, fit, baseCond };
