// The nightly pool of real homes for the quiz: for each county, homes for sale across every price
// band and style, each with its front photo read and its true style recorded. The quiz builds its
// deck from this pool, so cards are instant and every label matches the photo.
const idx = require('./idx');
const store = require('./boards');
const phototag = require('./phototag');
const { STYLES, COUNTIES } = require('./styles');

const BANDS = [',300000', '300000,500000', '500000,750000', '750000,1000000', '1000000,'];
const PER_QUERY = 12;
const KEEP = ['id', 'mls', 'url', 'address', 'street', 'city', 'county', 'zip', 'price', 'beds', 'baths', 'sqft', 'built', 'photo', 'office', 'lat', 'lng', 'acres', 'pool', 'stories', 'hoa', 'materials', 'ptype', 'remarks'];

async function each(tasks, n) {
  const out = new Array(tasks.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => { while (i < tasks.length) { const at = i++; out[at] = await tasks[at](); } }));
  return out;
}

// Rebuild one county. tagBudget caps how many new photos are read this run; the rest wait for tomorrow.
async function buildCounty(county, tagBudget, ms) {
  if (!COUNTIES[county]) return { county, error: 'unknown' };
  const jobs = [];
  BANDS.forEach((price) => STYLES.forEach((s) => jobs.push(() => idx.search(Object.assign({ price, location: { county: [county] } }, s.q), PER_QUERY))));
  const results = await each(jobs, 6);
  const byId = new Map();
  results.forEach((r) => (r ? r.list : []).forEach((l) => { if (!byId.has(l.id)) byId.set(l.id, l); }));
  const all = [...byId.values()];
  const prev = await store.readIn('pool', county).catch(() => null);
  const prior = {}; ((prev && prev.doc && prev.doc.homes) || []).forEach((h) => { if (phototag.STYLE_CODE[h.k]) prior[h.id] = phototag.STYLE_CODE[h.k]; });
  const before = Object.keys(await phototag.loadAll()).length;
  const tags = await phototag.tagAll(all, tagBudget, ms, prior);
  const read = Math.max(0, Object.keys(await phototag.loadAll()).length - before - Object.keys(prior).length);
  const homes = all.filter((l) => tags[l.id] && tags[l.id] !== 'NA' && phototag.CODE_STYLE[tags[l.id]])
    .map((l) => Object.assign(Object.fromEntries(KEEP.map((k) => [k, l[k]])), { k: phototag.CODE_STYLE[tags[l.id]] }));
  const untagged = all.filter((l) => !tags[l.id]).length;
  await store.upsert('pool', county, (doc) => { doc.at = Date.now(); doc.homes = homes; doc.untagged = untagged; });
  mem.delete(county);
  return { county, found: all.length, read, kept: homes.length, untagged, notFront: all.filter((l) => tags[l.id] === 'NA').length };
}

const mem = new Map();
async function load(counties) {
  const out = [];
  await Promise.all(counties.map(async (c) => {
    const hit = mem.get(c);
    if (hit && Date.now() - hit.t < 10 * 60000) { out.push(...hit.homes); return; }
    const cur = await store.readIn('pool', c).catch(() => null);
    const homes = (cur && cur.doc && cur.doc.homes) || [];
    mem.set(c, { t: Date.now(), homes });
    out.push(...homes);
  }));
  return out;
}

module.exports = { buildCounty, load, BANDS };
