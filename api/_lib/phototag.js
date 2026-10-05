// Reads a listing's main photo with Claude and records what it really shows: the architectural style
// of the house front, or "NA" when the photo isn't the front (pool, backyard, aerial, interior).
// MLS style labels are typed by listing agents and are often wrong, so the quiz only shows a home
// under the style its photo shows. Each listing is read once and the answer is kept.
const store = require('./boards');

const MODEL = process.env.STYLEDNA_TAG_MODEL || 'claude-haiku-4-5-20251001';
const SHARDS = 10;
const PROMPT = `You are tagging Dallas-Fort Worth listing photos for a home style quiz.
Answer with JSON only: {"ext":"<code>"}

ext = the architectural style of the house front in the photo. One code:
TR Traditional (builder brick or stone, hip and gable roofs, arched entry, typical suburban)
TS Transitional (cleaner take on traditional: white or light brick or stone, black windows, simple gables, little ornament)
MO Modern / Contemporary (flat or shed roofs, big glass, boxy forms, stucco or panel siding)
MF Modern Farmhouse (board and batten or white brick, black trim, metal roof accents, gables)
CR Craftsman (bungalow, tapered porch columns, front gable porch, exposed rafters)
TU Tudor (steep front-facing cross gables, half-timbering, storybook English look in stone or brick, arched doors)
ME Mediterranean / Spanish (tile roof, stucco, arches)
FR French / European (formal symmetry, tall hip or mansard roof, limestone or stucco, chateau or French country; steep front gables alone mean Tudor)
CO Cottage (small cottage, minimal traditional, painted brick)
MC Mid-Century Modern (1950s to 1970s low, long, horizontal profile, low-pitch or flat roof, wide overhangs, big windows)
RR Ranch (plain one-story ranch, ordinary gable or hip roof, no modern features)
HC Hill Country (Texas limestone, metal roof, lodge feel)
CT Colonial / Georgian (symmetrical two-story, columns or pediment, shutters)
BA Barndominium (metal barn-style home or metal building with living space)
NA the photo does not clearly show the front of a house (interior, backyard, pool, aerial or drone view, map, floor plan, sign, detail shot, land only)

Pick the single best code. Choose a specific style only when its features are clearly visible; otherwise TR.`;
const CODES = new Set(['TR', 'TS', 'MO', 'MF', 'CR', 'TU', 'ME', 'FR', 'CO', 'MC', 'RR', 'HC', 'CT', 'BA', 'NA']);
// Photo code -> StyleDNA style key.
const CODE_STYLE = { TR: 'traditional', TS: 'transitional', MO: 'modern', MF: 'farmhouse', CR: 'craftsman', TU: 'tudor', ME: 'mediterranean',
  FR: 'french', CO: 'cottage', MC: 'midcentury', RR: 'ranch', HC: 'hillcountry', CT: 'colonial', BA: 'barndo' };

const shardOf = (id) => 'tags' + (Number(String(id).slice(-3)) % SHARDS || 0);
const mem = { at: 0, tags: {} };
async function loadAll() {
  if (Date.now() - mem.at < 5 * 60000) return mem.tags;
  const docs = await Promise.all(Array.from({ length: SHARDS }, (_, i) => store.readIn('phototags', 'tags' + i).catch(() => null)));
  const tags = {};
  docs.forEach((d) => Object.assign(tags, (d && d.doc && d.doc.t) || {}));
  mem.at = Date.now(); mem.tags = tags;
  return tags;
}
async function save(newTags) {
  const byShard = {};
  Object.entries(newTags).forEach(([id, code]) => { (byShard[shardOf(id)] = byShard[shardOf(id)] || {})[id] = code; });
  await Promise.all(Object.entries(byShard).map(([sh, t]) => store.upsert('phototags', sh, (doc) => { doc.t = Object.assign(doc.t || {}, t); }).catch((e) => console.warn('tag save failed', e && e.message))));
  Object.assign(mem.tags, newTags);
}

async function readOne(url) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !/^https:\/\//.test(url)) return null;
  try {
    // Download the (small, 600px) photo ourselves; Claude's own URL fetching is rate limited.
    const img = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!img.ok) return null;
    const media = (img.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!/^image\/(jpeg|png|webp|gif)$/.test(media)) return null;
    const data = Buffer.from(await img.arrayBuffer()).toString('base64');
    for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 30, messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: media, data } }, { type: 'text', text: PROMPT }] }] }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 429 || r.status === 529) { await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1))); continue; }
    if (!r.ok) { console.warn('photo read failed', r.status, j && j.error && j.error.message); return null; }
    const m = ((j.content || []).map((c) => c.text || '').join('')).match(/"ext"\s*:\s*"([A-Z]{2})"/);
    return m && CODES.has(m[1]) ? m[1] : null;
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

module.exports = { tagAll, loadAll, readOne, CODE_STYLE, MODEL };
