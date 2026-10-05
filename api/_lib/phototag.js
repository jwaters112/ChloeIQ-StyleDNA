// Reads a listing's main photo with Claude and records what it really shows: the architectural style
// of the house front, or "NA" when the photo isn't the front (pool, backyard, aerial, interior).
// MLS style labels are typed by listing agents and are often wrong, so the quiz only shows a home
// under the style its photo shows. Each listing is read once and the answer is kept.
// v2: a stronger model, a larger photo, and the reader also says whether the house is fully visible
// and how sure it is. Obscured or unsure photos never reach the quiz.
const store = require('./boards');

const MODEL = process.env.STYLEDNA_TAG_MODEL || 'claude-sonnet-5-5';
const SPACE = 'phototags2';
const SHARDS = 10;
const PROMPT = `You are an architectural reviewer tagging Dallas-Fort Worth listing photos for a home style quiz.
Answer with JSON only: {"ext":"<code>","visible":"full|partial|no","conf":"high|medium|low"}

ext = the architectural style of the house in the photo. Judge the architecture itself: roof shape and pitch,
massing, proportions, window pattern, porch and entry. Do not judge by paint, finishes, landscaping or staging.
A remodeled 1960s ranch with modern paint and new windows is still RR or MC, not MO.

TR Traditional (builder brick or stone, hip and gable roofs, arched entry, typical suburban)
TS Transitional (simplified traditional massing: light brick or stone, black windows, clean gables, little ornament, no tile roof)
MO Modern / Contemporary (designed as modern from the start: flat or shed roofs, boxy volumes, large glass, stucco or panel siding)
MF Modern Farmhouse (board and batten or white brick, black trim, steep simple gables, metal roof accents, porch)
CR Craftsman (front-gable or low-pitched porch roof, tapered columns often on brick or stone piers, exposed rafters, bungalow proportions; brick does not make it Traditional)
TU Tudor (steep front-facing cross gables, half-timbering or a steep storybook brick and stone front, arched door, tall chimney)
ME Mediterranean / Spanish (clay tile roof, stucco, arches, wrought iron; a tile roof means ME even with some brick)
FR French / European (formal symmetry, tall hip or mansard roof, limestone or stucco, chateau or French country; steep front gables alone mean Tudor)
CO Cottage (small scale, minimal traditional, painted brick)
MC Mid-Century Modern (1950s to 1970s: low, long horizontal profile, low-pitch or flat roof, wide overhangs, clerestory or big windows)
RR Ranch (plain one-story ranch, ordinary gable or hip roof, small windows)
HC Hill Country (Texas limestone, metal roof, deep porches, lodge feel)
CT Colonial / Georgian (symmetrical two-story box, centered door, columns or pediment, shutters)
BA Barndominium (metal barn-style building with living space)
NA not a house front (interior, backyard, pool, aerial or drone view, map, floor plan, sign, detail shot, land only)

visible = full only when most of the house front is clearly in view; partial when trees, cars, angle or crop hide much of it; no when it isn't a house front.
conf = high only when the style's defining features are clearly visible and it isn't a close call between two styles.
Pick the single best code. When unsure between Traditional and something more specific, choose the specific style only if its features are clearly visible.`;
const CODES = new Set(['TR', 'TS', 'MO', 'MF', 'CR', 'TU', 'ME', 'FR', 'CO', 'MC', 'RR', 'HC', 'CT', 'BA', 'NA']);
// Photo code -> StyleDNA style key.
const CODE_STYLE = { TR: 'traditional', TS: 'transitional', MO: 'modern', MF: 'farmhouse', CR: 'craftsman', TU: 'tudor', ME: 'mediterranean',
  FR: 'french', CO: 'cottage', MC: 'midcentury', RR: 'ranch', HC: 'hillcountry', CT: 'colonial', BA: 'barndo' };

const shardOf = (id) => 'tags' + (Number(String(id).slice(-3)) % SHARDS || 0);
// Stored per listing: the style code, 'XX~' for a medium-confidence read, or 'NA' (not usable).
const mem = { at: 0, tags: {} };
async function loadAll() {
  if (Date.now() - mem.at < 5 * 60000) return mem.tags;
  const docs = await Promise.all(Array.from({ length: SHARDS }, (_, i) => store.readIn(SPACE, 'tags' + i).catch(() => null)));
  const tags = {};
  docs.forEach((d) => Object.assign(tags, (d && d.doc && d.doc.t) || {}));
  mem.at = Date.now(); mem.tags = tags;
  return tags;
}
async function save(newTags) {
  const byShard = {};
  Object.entries(newTags).forEach(([id, code]) => { (byShard[shardOf(id)] = byShard[shardOf(id)] || {})[id] = code; });
  await Promise.all(Object.entries(byShard).map(([sh, t]) => store.upsert(SPACE, sh, (doc) => { doc.t = Object.assign(doc.t || {}, t); }).catch((e) => console.warn('tag save failed', e && e.message))));
  Object.assign(mem.tags, newTags);
}

async function readOne(url) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !/^https:\/\//.test(url)) return null;
  try {
    // Download the 800px photo ourselves; Claude's own URL fetching is rate limited.
    const img = await fetch(url.replace('/w600_original_', '/w800_original_'), { signal: AbortSignal.timeout(8000) });
    if (!img.ok) return null;
    const media = (img.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!/^image\/(jpeg|png|webp|gif)$/.test(media)) return null;
    const data = Buffer.from(await img.arrayBuffer()).toString('base64');
    for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 60, messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: media, data } }, { type: 'text', text: PROMPT }] }] }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 429 || r.status === 529) { await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1))); continue; }
    if (!r.ok) { console.warn('photo read failed', r.status, j && j.error && j.error.message); return null; }
    const text = (j.content || []).map((c) => c.text || '').join('');
    const m = text.match(/"ext"\s*:\s*"([A-Z]{2})"/), v = (text.match(/"visible"\s*:\s*"(\w+)"/) || [])[1], cf = (text.match(/"conf"\s*:\s*"(\w+)"/) || [])[1];
    if (!m || !CODES.has(m[1])) return null;
    if (m[1] === 'NA' || v !== 'full' || cf === 'low') return 'NA';
    return cf === 'high' ? m[1] : m[1] + '~';
    }
    return null;
  } catch (e) { return null; }
}

// listings: [{ id, photo }]. Reads the ones not seen before (up to `budget`), within `ms`.
// Returns { id: code } for everything known afterwards.
async function tagAll(listings, budget, ms) {
  const known = await loadAll();
  const todo = [], seen = new Set();
  listings.forEach((l) => { if (l && l.id && l.photo && !known[l.id] && !seen.has(l.id)) { seen.add(l.id); todo.push(l); } });
  const queue = todo.slice(0, budget || 0), fresh = {};
  const stopAt = Date.now() + (ms || 6000);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(10, queue.length) }, async () => {
    while (i < queue.length && Date.now() < stopAt) { const l = queue[i++]; const code = await readOne(l.photo); if (code) fresh[l.id] = code; }
  }));
  if (Object.keys(fresh).length) await save(fresh);
  return Object.assign({}, known, fresh);
}

const STYLE_CODE = Object.fromEntries(Object.entries(CODE_STYLE).map(([c, k]) => [k, c]));
// 'CR~' -> { code: 'CR', sure: false }; 'NA' or unknown -> null.
function parse(tag) { if (!tag || tag === 'NA') return null; const code = tag.replace('~', ''); return CODE_STYLE[code] ? { code, k: CODE_STYLE[code], sure: !tag.endsWith('~') } : null; }
module.exports = { tagAll, loadAll, readOne, parse, CODE_STYLE, STYLE_CODE, MODEL };
