// Builds the swipe deck from real homes for sale in the areas someone picked, scores homes against
// their must-haves, and answers "how many homes in my style are near me, and if none, where?".
const idx = require('./idx');
const { STYLES, BY_KEY, COUNTIES } = require('./styles');
const pool = require('./pool');
const phototag = require('./phototag');
const roomsLib = require('./rooms');
const finLib = require('./finish');

const PRICES = new Set([',300000', '300000,500000', '500000,750000', '750000,1000000', '1000000,']);
const TYPES = new Set(['Single Family Home', 'Townhouse', 'Condo']);
const LEVEL = new Set(['must', 'nice']);
const MUST_KEYS = ['onestory', 'pool', 'acres', 'gameroom', 'suite', 'access', 'office', 'primarydown', 'garage3', 'outdoor', 'shop', 'newer'];
const clip = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

// ---- "Get specific": a detailed checklist (Must / Nice / Never), ranges and a keyword ----
// Each item is checked from the listing's data fields first ("confirmed"), then from the listing
// description ("the listing says"). Items we can't check reliably aren't offered.
const YEAR = new Date().getFullYear();
const SPEC = {
  splitbeds: { label: 'Split bedrooms', g: 'Layout', r: /split[- ](bed|bedroom|floor ?plan|plan)|split bedrooms/ },
  guestdown: { label: 'Guest suite or bedroom down', g: 'Layout', r: /(guest|second|2nd|secondary) (bed(room)?|suite)s? (is |are )?(down|downstairs|on the (first|main))|guest suite down|(in-?law|mother-?in-?law) (suite|quarters)/ },
  living2: { label: 'Two or more living areas', g: 'Layout', r: /(second|2nd|two|additional|upstairs|downstairs) living|game ?room|media room|bonus room|flex room|\bloft\b/ },
  media: { label: 'Media room or theater', g: 'Layout', r: /media room|theater|theatre/ },
  ceilings: { label: 'Tall ceilings (10 ft+)', g: 'Layout', r: /\b(1\d|2\d) ?(ft|foot|feet|')? ?(tall |high )?ceilings?|(high|soaring|tall|vaulted|cathedral) ceilings?/ },
  fireplace: { label: 'Fireplace', g: 'Layout', d: (l) => l.fireplace === true, r: /fireplace/ },
  island: { label: 'Kitchen island', g: 'Kitchen and finishes', r: /island/ },
  gas: { label: 'Gas cooking', g: 'Kitchen and finishes', d: (l) => /gas (cooktop|range|oven)/.test(l.feat || ''), r: /gas (cooktop|range|stove|cooking)/ },
  doubleoven: { label: 'Double ovens', g: 'Kitchen and finishes', d: (l) => /double oven/.test(l.feat || ''), r: /double ovens?|dual ovens?/ },
  walkin: { label: 'Walk-in pantry', g: 'Kitchen and finishes', r: /walk[- ]in pantry/ },
  butler: { label: "Butler's pantry", g: 'Kitchen and finishes', r: /butler'?s? pantry/ },
  wood: { label: 'Wood floors', g: 'Kitchen and finishes', r: /hardwood|wood floors?|engineered wood|wide[- ]plank/ },
  culdesac: { label: 'Cul-de-sac', g: 'Lot and outside', r: /cul[- ]de[- ]sac/ },
  corner: { label: 'Corner lot', g: 'Lot and outside', r: /corner lot/ },
  greenbelt: { label: 'Backs to greenbelt or open space', g: 'Lot and outside', r: /green ?belt|backs (up )?to (a |the )?(park|creek|pond|lake|open space|trees|woods|nature|golf|preserve)|open space behind|no (rear|back(yard)?) neighbors|no neighbors behind/ },
  covered: { label: 'Covered patio', g: 'Lot and outside', d: (l) => /covered/.test(l.porch || ''), r: /covered (patio|porch|back porch|outdoor|deck)/ },
  outkitchen: { label: 'Outdoor kitchen', g: 'Lot and outside', r: /outdoor kitchen|summer kitchen|built[- ]in grill/ },
  roompool: { label: 'Room for a pool', g: 'Lot and outside', r: /room for (a )?pool|space for (a )?pool|pool[- ]sized/ },
  waterfront: { label: 'Waterfront', g: 'Lot and outside', d: (l) => l.waterfront === true, r: /waterfront|lakefront|lake front/ },
  sidegarage: { label: 'Side or rear entry garage', g: 'Garage', d: (l) => /garage faces (side|rear)/.test(l.feat || ''), r: /(side|rear)[- ]entry garage|j[- ]swing/ },
  tandem: { label: 'Tandem garage space', g: 'Garage', d: (l) => /tandem/.test(l.feat || ''), r: /tandem/ },
  oversized: { label: 'Oversized garage or workshop', g: 'Garage', d: (l) => /oversized/.test(l.feat || ''), r: /oversized garage|workshop/ },
  ev: { label: 'EV charging', g: 'Garage', d: (l) => /electric vehicle/.test(l.feat || ''), r: /\bev charg|electric vehicle/ },
  newcon: { label: 'New construction', g: 'The house', d: (l) => l.newcon === true || (l.built && l.built >= YEAR - 1), r: /new construction|never lived in/ },
  detached: { label: 'No shared walls', g: 'The house', d: (l) => l.attached ? l.attached === 'No' : /single family/i.test(l.ptype || '') },
  nohoa: { label: 'No HOA', g: 'The house', d: (l) => l.hoa === false },
  reduced: { label: 'Price reduced', g: 'The house', d: (l) => l.reduced === true },
  openhouse: { label: 'Open house scheduled', g: 'The house', d: (l) => l.openh === true },
  // Read from the inside photos (kitchen, living room, primary bath). Only the finishes that proved reliable in testing.
  cabwhite: { label: 'White kitchen cabinets', g: 'From photos', p: (f) => f.cab === 'white' },
  cabwood: { label: 'Wood-tone kitchen cabinets', g: 'From photos', p: (f) => /wood/.test(f.cab || '') },
  nocarpet: { label: 'No carpet in living areas', g: 'From photos', p: (f) => f.carpet === false },
  updated: { label: 'Updated or new look', g: 'From photos', p: (f) => f.look === 'new or recently updated' },
};
const SPEC_LEVEL = new Set(['must', 'nice', 'never']);
// 'yes' when a data field confirms it, 'says' when only the description mentions it, '' when neither.
function specHas(k, l) {
  const it = SPEC[k]; if (!it) return '';
  if (it.p) return l.fin && !l.fin.none && it.p(l.fin) ? 'photo' : '';
  if (it.d && it.d(l)) return 'yes'; return it.r && it.r.test(l.remarks || '') ? 'says' : '';
}
const RANGE_KEYS = { bedsMin: [0, 10], bathsMin: [0, 10], sqftMin: [0, 20000], sqftMax: [0, 20000], acresMin: [0, 500], acresMax: [0, 500], builtMin: [1900, YEAR + 2], builtMax: [1900, YEAR + 2] };
function inRange(l, r) {
  if (!r) return true;
  const out = (v, lo, hi) => v > 0 && ((lo && v < lo) || (hi && v > hi));
  return !(out(l.beds, r.bedsMin) || out(l.baths, r.bathsMin) || out(l.sqft, r.sqftMin, r.sqftMax) || out(l.acres, r.acresMin, r.acresMax) || out(l.built, r.builtMin, r.builtMax));
}
// What a home has and lacks against their checklist, for the results list.
function specRead(l, c) {
  const yes = [], says = [], photo = [], no = [], bad = [];
  Object.entries(c.feat || {}).forEach(([k, v]) => {
    const h = specHas(k, l), lab = SPEC[k].label;
    if (v === 'never') { if (h) bad.push(lab); return; }
    if (h === 'yes') yes.push(lab); else if (h === 'says') says.push(lab); else if (h === 'photo') photo.push(lab); else if (v === 'must') no.push(lab);
  });
  return { yes, says, photo, no, bad };
}

// Whatever the browser sends, keep only values we know.
function criteria(b) {
  b = b || {};
  const counties = (Array.isArray(b.counties) ? b.counties : []).filter((c) => COUNTIES[c]).slice(0, 8);
  const cities = (Array.isArray(b.cities) ? b.cities : []).map((c) => clip(c, 40).replace(/[^A-Za-z .'-]/g, '')).filter(Boolean).slice(0, 12);
  const must = {}, picks = {};
  MUST_KEYS.forEach((k) => { const v = b.must && b.must[k]; if (LEVEL.has(v)) must[k] = v; });
  const allowed = { exterior: ['brick', 'stone', 'stucco', 'siding'], layout: ['open', 'separate'], condition: ['ready', 'updates', 'project'], hoa: ['no', 'yes'], setting: ['near', 'secluded'] };
  // Quick picks can have more than one answer each (older saves send a single value).
  Object.entries(allowed).forEach(([k, vals]) => { const v = b.picks && b.picks[k]; const list = (Array.isArray(v) ? v : [v]).filter((x) => vals.includes(x)); if (list.length) picks[k] = [...new Set(list)]; });
  // Several budget bands and home types can be picked; the search runs over the full span, then each home is checked.
  const prices = (Array.isArray(b.prices) ? b.prices : [b.price]).filter((x) => PRICES.has(x));
  const types = (Array.isArray(b.types) ? b.types : [b.type]).filter((x) => TYPES.has(x));
  const span = prices.length ? [Math.min(...prices.map((x) => Number(x.split(',')[0]) || 0)), prices.some((x) => !x.split(',')[1]) ? 0 : Math.max(...prices.map((x) => Number(x.split(',')[1]) || 0))] : null;
  const price = span ? (span[0] || '') + ',' + (span[1] || '') : '';
  const feat = {}; Object.keys(SPEC).forEach((k) => { const v = b.feat && b.feat[k]; if (SPEC_LEVEL.has(v)) feat[k] = v; });
  const rng = {}; Object.entries(RANGE_KEYS).forEach(([k, [lo, hi]]) => { const v = Number(b.rng && b.rng[k]); if (Number.isFinite(v) && v > lo && v <= hi) rng[k] = v; });
  ['sqft', 'acres', 'built'].forEach((k) => { if (rng[k + 'Min'] && rng[k + 'Max'] && rng[k + 'Min'] > rng[k + 'Max']) delete rng[k + 'Max']; });
  const keyword = clip(String(b.keyword || ''), 40).replace(/[^A-Za-z0-9 '&-]/g, '').trim();
  return { counties, cities, price: price === ',' ? '' : price, prices: [...new Set(prices)], type: types.length === 1 ? types[0] : '', types: [...new Set(types)], must, picks, feat, rng, keyword };
}

function baseCond(c, countiesOverride) {
  const cond = {};
  if (c.types && c.types.length) cond.propertytype = c.types;
  if (c.price) cond.price = c.price;
  const counties = countiesOverride || c.counties;
  if (!countiesOverride && c.cities.length) cond.location = { city: c.cities.map((x) => x + ', TX') };
  else cond.location = { county: counties.length ? counties : Object.keys(COUNTIES) };
  if (c.must.acres === 'must') cond.acres = '1,';
  // Ranges and a keyword go straight into the listing search, so counts are exact.
  const r = c.rng || {}, span = (lo, hi) => (lo || '') + ',' + (hi || '');
  if (r.bedsMin) cond.beds = r.bedsMin + ',';
  if (r.bathsMin) cond.baths = r.bathsMin + ',';
  if (r.sqftMin || r.sqftMax) cond.sqft = span(r.sqftMin, r.sqftMax);
  if (r.builtMin || r.builtMax) cond.yearbuilt = span(r.builtMin, r.builtMax);
  if (r.acresMin || r.acresMax) cond.acres = span(Math.max(r.acresMin || 0, c.must.acres === 'must' ? 1 : 0) || '', r.acresMax);
  if (c.keyword) cond.keyword = [c.keyword];
  return cond;
}

// ---- what a listing has, read from the MLS fields and the remarks ----
const has = {
  pool: (l) => l.pool,
  acres: (l) => l.acres >= 1,
  gameroom: (l) => /game ?room|media room|theater|theatre|bonus room/.test(l.remarks),
  suite: (l) => /guest suite|in-law|mother-in-law|casita|guest quarters|guest house|second primary|dual primar|next ?gen|multi-?gen/.test(l.remarks),
  // Single story: the listing's story count, or the remarks when the count is blank.
  onestory: (l) => { const st = String(l.stories || '').trim(); return st ? /^(one|1|single)( story| level)?$/i.test(st) : /\b(single|one)[- ](story|level)\b/i.test(l.remarks || ''); },
  access: (l) => /^(one|1)$/i.test(l.stories) || /single[- ]story|one[- ]story|wheelchair|no[- ]step|wide doorways|accessib/.test(l.remarks),
  office: (l) => /\b(home office|study|private office|office)\b/.test(l.remarks),
  primarydown: (l) => /^(one|1)$/i.test(l.stories) || /(primary|master|owner'?s?)( bedroom| suite| retreat)? (is )?(down|downstairs|on the (first|main) (floor|level))|(first|main)[- ](floor|level) (primary|master|owner)|(primary|master) (bedroom |suite )?down\b/.test(l.remarks),
  garage3: (l) => /\b(3|three|4|four|5|five)[- ]car garage|\b(3|4|5) car\b/.test(l.remarks),
  outdoor: (l) => /outdoor kitchen|covered patio|outdoor living|summer kitchen|pergola|covered porch|outdoor fireplace/.test(l.remarks),
  shop: (l) => /workshop|\bshop\b|rv (parking|pad|garage|gate|hookup)|boat (parking|storage)|\bbarn\b|detached garage/.test(l.remarks),
  newer: (l) => l.built >= 2015,
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
const FEATURE_LABEL = { onestory: 'Single story', pool: 'Pool', acres: '1+ acre', gameroom: 'Game room', suite: 'Guest suite', access: 'One story', office: 'Office', primarydown: 'Primary down', garage3: '3+ car garage', outdoor: 'Outdoor living', shop: 'Shop or RV parking', newer: 'Built 2015 or later' };
function fit(l, c) {
  let score = 0; const hits = [];
  Object.entries(c.must).forEach(([k, lvl]) => {
    if (has[k](l)) { score += lvl === 'must' ? 3 : 1; hits.push(FEATURE_LABEL[k]); } else if (lvl === 'must') score -= 2;
  });
  Object.entries(c.feat || {}).forEach(([k, lvl]) => { if (lvl === 'never') return; if (specHas(k, l)) { score += lvl === 'must' ? 2 : 1; } });
  Object.entries(c.picks).forEach(([k, vals]) => { if ((Array.isArray(vals) ? vals : [vals]).some((v) => pickHas[k] && pickHas[k][v] && pickHas[k][v](l))) score += 1; });
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
  const onlyAttached = c.types && c.types.length && !c.types.includes('Single Family Home');
  return STYLES.filter((s) => !(onlyAttached && ['barndo', 'hillcountry'].includes(s.k)));
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
const ROOM_LABEL = { living: 'Living room', kitchen: 'Kitchen', primary_bath: 'Primary bath', pool: 'Pool', game: 'Game room', aerial: 'From above', office: 'Office', rear: 'Outdoor living' };
function cardPhotos(l, c, rooms) {
  const r = rooms && rooms[l.id];
  // Not sorted yet: front photo only, so a floor plan, map or sign can never show on a card.
  if (!r) return { photos: [l.photo], plabels: ['Front'] };
  const slots = ['living', 'kitchen', 'primary_bath'];
  const wants = (k) => c.must[k] === 'must' || c.must[k] === 'nice';
  if (wants('pool')) slots.push('pool');
  if (wants('gameroom')) slots.push('game');
  if (wants('office')) slots.push('office');
  if (wants('outdoor')) slots.push('rear');
  if (wants('acres')) slots.push('aerial');
  const photos = [l.photo], plabels = ['Front'], used = new Set([l.photo]);
  slots.forEach((k) => { const u = (r[k] || []).find((x) => !used.has(x)); if (u) { used.add(u); photos.push(u); plabels.push(ROOM_LABEL[k]); } });
  // Rooms for the "inside" round at the end of the deck.
  const ins = {}; ['living', 'kitchen', 'primary_bath', 'primary_bed', 'dining'].forEach((k) => { if (r[k] && r[k][0]) ins[k] = r[k][0]; });
  // Every sorted room, one photo each, so the phone can show more or fewer and lead with the rooms this person stops on.
  const rm = {}; ['living', 'kitchen', 'primary_bath', 'primary_bed', 'dining', 'pool', 'rear', 'aerial', 'game', 'office'].forEach((k) => { const u = (r[k] || []).find((x) => x !== l.photo); if (u) rm[k] = u; });
  return { photos, plabels, ins, rm };
}
// Must-haves this home doesn't have (only ones we can check from the listing).
const missing = (l, c) => Object.keys(c.must).filter((m) => c.must[m] === 'must' && has[m] && !has[m](l))
  .concat(Object.keys(c.feat || {}).filter((k) => (c.feat[k] === 'must') === !specHas(k, l) && c.feat[k] !== 'nice'));
function card(l, s, c, near, rooms) {
  const f = fit(l, c);
  return { id: l.id, k: s.k, label: s.label, desc: s.desc, photo: l.photo, ...cardPhotos(l, c, rooms), url: l.url, address: l.address, city: l.city, county: l.county,
    price: l.price, beds: l.beds, baths: l.baths, sqft: l.sqft, acres: l.acres, pool: l.pool, office: l.office, facts: factsLine(l), hits: f.hits, near: !!near, miss: missing(l, c), t: traits(l), ...(Object.keys(c.feat || {}).length ? { sp: specRead(l, c) } : {}) };
}

const DECK_SIZE = 20;
const TYPE_RE = { 'Single Family Home': /single family/i, Townhouse: /town/i, Condo: /condo/i };
function inSearch(l, c, cities) {
  const bands = c.prices && c.prices.length ? c.prices : c.price ? [c.price] : [];
  if (bands.length && !bands.some((b) => { const [lo, hi] = b.split(',').map((x) => Number(x) || 0); return !((lo && l.price < lo) || (hi && l.price > hi)); })) return false;
  if (c.types && c.types.length && l.ptype && !c.types.some((t) => TYPE_RE[t] && TYPE_RE[t].test(l.ptype))) return false;
  if (cities && cities.size && !cities.has(String(l.city || '').toLowerCase())) return false;
  if (c.must.acres === 'must' && !(l.acres >= 1)) return false;
  if (!inRange(l, c.rng)) return false;
  if (c.keyword && l.remarks && !String(l.remarks).includes(c.keyword.toLowerCase())) return false;
  return true;
}
// Swipe cards follow their must-haves when there are enough matching homes for a full deck. When there
// aren't, the closest homes fill in and each says what it's missing, so it reads as a style card, not a match.
const STRICT_MIN = 14;
async function buildDeck(input) {
  const c = criteria(input);
  const hard = Object.keys(c.must).some((m) => c.must[m] === 'must' && has[m]) || Object.values(c.feat || {}).some((v) => v !== 'nice');
  if (hard) {
    const strict = await buildDeckFor(input, true);
    if (strict.cards.filter((x) => !x.probe).length >= STRICT_MIN) return Object.assign(strict, { mustOnly: true });
  }
  return buildDeckFor(input, false);
}
async function buildDeckFor(input, strict) {
  const c = criteria(input);
  const rooms = await roomsLib.loadAll().catch(() => ({}));
  const fins = Object.values(c.feat || {}).length ? await finLib.loadAll().catch(() => ({})) : {};
  const withFin = (list) => list.map((l) => (fins[l.id] && !l.fin ? Object.assign({}, l, { fin: fins[l.id] }) : l));
  const styles = stylesFor(c);
  const counties = c.counties.length ? c.counties : Object.keys(COUNTIES);
  const cities = new Set(c.cities.map((x) => x.toLowerCase()));
  // Swipe cards need photos to flip through: a card needs the front plus at least two more views
  // (living, kitchen, bath...). One-photo listings, often new builds with a single rendering, stay
  // out of the deck; they still count and show in the results list.
  let minPhotos = 3;
  const pick = (homes, near) => {
    const cands = {}, seen = new Set();
    homes.forEach((l) => {
      if (seen.has(l.id) || !BY_KEY[l.k] || !styles.some((s) => s.k === l.k)) return; seen.add(l.id);
      const cd = card(l, BY_KEY[l.k], c, near, rooms);
      if (cd.photos.length < minPhotos) return;
      if (strict && cd.miss.length) return;
      (cands[l.k] = cands[l.k] || []).push(Object.assign(cd, { _f: fit(l, c).score + Math.random() * 0.6 }));
    });
    Object.values(cands).forEach((a) => a.sort((x, y) => y._f - x._f));
    return cands;
  };
  let homes = withFin((await pool.load(counties)).filter((l) => inSearch(l, c, cities)));
  let source = 'pool';
  if (!homes.length && !(await pool.load(counties)).length) {
    // Pool not built for these counties yet: look live, and read photos now (slower, first time only).
    source = 'live';
    const results = await each(styles.map((s) => () => idx.search(Object.assign({}, baseCond(c), s.q), 12)), 6);
    const all = []; results.forEach((r) => (r ? r.list : []).forEach((l) => all.push(l)));
    const tags = await phototag.tagAll(all, 60, 7000);
    homes = all.map((l) => { const t = phototag.parse(tags[l.id]); return t && t.sure ? Object.assign({}, l, { k: t.k }) : null; }).filter(Boolean);
    await roomsLib.sortAll(homes, 16, 6000).catch(() => null);
    Object.assign(rooms, await roomsLib.loadAll().catch(() => ({})));
  }
  // Narrow city picks the nightly sample doesn't cover well: look those cities up live and read any new photos now.
  if (source === 'pool' && cities.size && homes.length < DECK_SIZE) {
    const results = await each(styles.map((s) => () => idx.search(Object.assign({}, baseCond(c), s.q), 12)), 6);
    const have = new Set(homes.map((l) => l.id)), fresh = [];
    results.forEach((r) => (r ? r.list : []).forEach((l) => { if (!have.has(l.id)) { have.add(l.id); fresh.push(l); } }));
    if (fresh.length) {
      const tags = await phototag.tagAll(fresh, 40, 5000);
      const kept = [];
      fresh.forEach((l) => { const t = phototag.parse(tags[l.id]); if (t && t.sure) kept.push(Object.assign({}, l, { k: t.k })); });
      // Sort these homes' photos now too, so they can show inside photos on their cards.
      await roomsLib.sortAll(kept, 16, 6000).catch(() => null);
      Object.assign(rooms, await roomsLib.loadAll().catch(() => ({})));
      kept.forEach((l) => homes.push(l));
    }
  }
  let cands = pick(homes, false);
  // Very thin area: allow two-photo cards rather than an empty deck. One-photo cards never show.
  if (Object.values(cands).flat().length < 12) { minPhotos = 2; cands = pick(homes, false); }
  // Emergency only (the nightly pool is missing): a quiz with front photos beats no quiz.
  if (!Object.values(cands).flat().length) { minPhotos = 1; cands = pick(homes, false); }
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
  const [first, mine0, tags, fins] = await Promise.all([idx.search(cond, PAGE, 1), pool.load(counties), phototag.loadAll().catch(() => ({})), Object.keys(c.feat || {}).length ? finLib.loadAll().catch(() => ({})) : {}]);
  const addFin = (l) => (fins[l.id] && !l.fin ? Object.assign({}, l, { fin: fins[l.id] }) : l);
  const mine = mine0.map(addFin);
  const liveTotal = first ? first.count : 0;
  const pages = [first];
  if (first && liveTotal > PAGE) {
    const more = await Promise.all(Array.from({ length: Math.min(LIST_PAGES, Math.ceil(liveTotal / PAGE)) - 1 }, (_, i) => idx.search(cond, PAGE, i + 2)));
    pages.push(...more);
  }
  const liveList = []; pages.forEach((r) => (r ? r.list : []).forEach((l) => liveList.push(addFin(l))));
  const hard = Object.keys(c.must).filter((m) => c.must[m] === 'must' && has[m]);
  const okFeat = (l) => Object.entries(c.feat || {}).every(([fk, v]) => v === 'never' ? !specHas(fk, l) : v === 'must' ? !!specHas(fk, l) : true);
  const ok = (l) => hard.every((m) => has[m](l)) && okFeat(l);
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
  const est = unread > 0 && (hard.length > 0 || Object.keys(c.feat || {}).length > 0);
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

module.exports = { criteria, buildDeck, availability, fit, baseCond, SPEC, specHas };
