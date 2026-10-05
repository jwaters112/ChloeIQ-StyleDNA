// The nightly pool of real homes for the quiz: for each county, homes for sale across every price
// band and style, each with its front photo read and its true style recorded. The quiz builds its
// deck from this pool, so cards are instant and every label matches the photo.
const idx = require('./idx');
const store = require('./boards');
const phototag = require('./phototag');
const { STYLES, COUNTIES } = require('./styles');

const BANDS = [',300000', '300000,500000', '500000,750000', '750000,1000000', '1000000,'];
const PER_QUERY = 12;
const KEEP = ['id', 'mls', 'url', 'address', 'street', 'city', 'county', 'zip', 'price', 'beds', 'baths', 'sqft', 'built', 'photo', 'photos', 'office', 'lat', 'lng', 'acres', 'pool', 'stories', 'hoa', 'materials', 'ptype', 'remarks'];

async function each(tasks, n) {
  const out = new Array(tasks.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => { while (i < tasks.length) { const at = i++; out[at] = await tasks[at](); } }));
  return out;
}

// Rebuild one county. tagBudget caps how many new photos are read this run; the rest wait for tomorrow.
async function buildCounty(county, tagBudget, ms) {
  if (!COUNTIES[county]) return { county, error: 'unknown' };
  const jobs = [], meta = [];
  BANDS.forEach((price) => STYLES.forEach((s) => { meta.push(s); jobs.push(() => idx.search(Object.assign({ price, location: { county: [county] } }, s.q), PER_QUERY)); }));
  const results = await each(jobs, 6);
  // Remember which MLS label found each home: a second opinion when the photo read is unsure.
  const byId = new Map(), mlsSays = {};
  results.forEach((r, i) => (r ? r.list : []).forEach((l) => {
    if (!byId.has(l.id)) byId.set(l.id, l);
    if (meta[i].q.style && meta[i].k !== 'traditional') mlsSays[l.id] = meta[i].k;
  }));
  const all = [...byId.values()];
  // Listing search failed or was throttled: keep yesterday's homes rather than saving an empty county.
  const failed = results.filter((r) => !r).length;
  if (!all.length || failed > results.length / 3) return { county, found: all.length, failed, skipped: 'search unavailable, kept existing' };
  const before = Object.keys(await phototag.loadAll()).length;
  const tags = await phototag.tagAll(all, tagBudget, ms);
  const read = Math.max(0, Object.keys(await phototag.loadAll()).length - before);
  let doubtful = 0;
  const homes = [];
  all.forEach((l) => {
    const t = phototag.parse(tags[l.id]);
    if (!t) return;
    if (!t.sure && mlsSays[l.id] && mlsSays[l.id] !== t.k) { doubtful++; return; }
    homes.push(Object.assign(Object.fromEntries(KEEP.map((k) => [k, l[k]])), { k: t.k, sure: t.sure }));
  });
  const untagged = all.filter((l) => !tags[l.id]).length;
  await store.upsert('pool', county, (doc) => { doc.at = Date.now(); doc.v = 2; doc.homes = homes; doc.untagged = untagged; });
  mem.delete(county);
  return { county, found: all.length, read, kept: homes.length, untagged, doubtful, notUsable: all.filter((l) => tags[l.id] === 'NA').length };
}

const mem = new Map();
async function load(counties) {
  const out = [];
  await Promise.all(counties.map(async (c) => {
    const hit = mem.get(c);
    if (hit && Date.now() - hit.t < 10 * 60000) { out.push(...hit.homes); return; }
    const cur = await store.readIn('pool', c).catch(() => null);
    const homes = (cur && cur.doc && cur.doc.v === 2 && cur.doc.homes) || [];
    mem.set(c, { t: Date.now(), homes });
    out.push(...homes);
  }));
  return out;
}

// Every city with homes for sale in each county, read from real listings. Listing addresses use the
// post office city, so a "Dallas" address can sit in Collin County. A town only counts under a county
// when that county holds a real share of the town's homes (or the town is only in that county), so
// towns that truly cross county lines (Frisco, Prosper, Carrollton) show under each, and mailing-address
// strays (Dallas under Denton) don't.
const SPELL = { 'Desoto': 'DeSoto', 'Mclendon Chisholm': 'McLendon-Chisholm', 'Mclendon-Chisholm': 'McLendon-Chisholm' };
const titleCase = (x) => { const t = String(x || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).trim(); return SPELL[t] || t.replace(/\bMc([a-z])/g, (m, a) => 'Mc' + a.toUpperCase()); };
const CITY_SHARE = 0.15;
// Mailing towns whose actual city limits sit outside that county (checked by hand), plus listing placeholders.
const NOT_IN = { _: ['No City'], Hunt: ['Wills Point', 'Leonard', 'Cumby', 'Ladonia'], Kaufman: ['Wills Point'], Collin: ['Leonard'], Parker: ['Perrin'], Hood: ['Bluff Dale'], Wise: ['Sunset'] };
const notIn = (county, c) => NOT_IN._.includes(c) || (NOT_IN[county] || []).includes(c);
async function buildCities() {
  const jobs = [];
  Object.keys(COUNTIES).forEach((county) => BANDS.forEach((price) => [1, 2].forEach((page) => jobs.push(() => idx.search({ price, location: { county: [county] } }, 100, page).then((r) => ({ county, price, r }))))));
  const out = await each(jobs, 3);
  // Each price band is a sample; weight it up to the band's full count so big and small counties compare fairly.
  const fetched = {};
  out.forEach(({ county, price, r }) => { const k = county + price; fetched[k] = (fetched[k] || 0) + (r ? r.list.length : 0); });
  const w = {}, total = {};
  out.forEach(({ county, price, r }) => {
    if (!r) return;
    const k = county + price, scale = fetched[k] ? Math.max(1, r.count / fetched[k]) : 1;
    r.list.forEach((l) => {
      if (!l.city || (l.county && String(l.county).replace(/ county$/i, '').toLowerCase() !== county.toLowerCase())) return;
      const c = titleCase(l.city);
      (w[county] = w[county] || {})[c] = (w[county][c] || 0) + scale;
      total[c] = (total[c] || 0) + scale;
    });
  });
  const map = {}, share = {};
  Object.entries(w).forEach(([county, t]) => {
    map[county] = Object.keys(t).filter((c) => t[c] / total[c] >= CITY_SHARE && !notIn(county, c)).sort();
    share[county] = Object.fromEntries(Object.keys(t).map((c) => [c, Math.round(t[c] / total[c] * 100)]));
  });
  if (Object.keys(map).length >= 8) await store.upsert('pool', 'cities', (doc) => { doc.at = Date.now(); doc.v = 2; doc.map = map; doc.share = share; });
  citiesMem.t = 0;
  return { counts: Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.length])), map, share };
}
const citiesMem = { t: 0, map: null };
async function cities() {
  if (citiesMem.map && Date.now() - citiesMem.t < 30 * 60000) return citiesMem.map;
  const cur = await store.readIn('pool', 'cities').catch(() => null);
  citiesMem.map = (cur && cur.doc && cur.doc.map) || {}; citiesMem.t = Date.now();
  return citiesMem.map;
}

module.exports = { buildCounty, load, BANDS, buildCities, cities };
