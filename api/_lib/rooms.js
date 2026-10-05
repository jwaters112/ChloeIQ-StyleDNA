// Sorts a listing's photos by what they show (front, living room, kitchen, primary bath, pool, aerial...)
// so each swipe card can show the same kinds of photos in the same order. One Claude call per home reads
// up to 24 small photos at once. Results are kept per listing, so each home is read only once.
const store = require('./boards');

const MODEL = process.env.STYLEDNA_ROOM_MODEL || 'claude-haiku-4-5-20251001';
const SPACE = 'rooms1';
const SHARDS = 10;
const MAX_PICS = 24;
const CODES = ['front', 'rear', 'aerial', 'pool', 'living', 'kitchen', 'dining', 'primary_bed', 'bed', 'primary_bath', 'bath', 'game', 'office', 'other'];
const PROMPT = `These are listing photos of one home for sale, numbered in order. For each photo, say what it shows.
Codes: front (the street-facing front of the house), rear (back of the house or backyard without a pool), aerial (drone or overhead view of the property or lot),
pool (backyard pool), living (living or family room), kitchen, dining, primary_bed (the largest, best-styled bedroom), bed (other bedroom),
primary_bath (the main bathroom: double vanity, large shower or soaking tub), bath (other bathroom), game (game room, media room or theater),
office, other (hallway, laundry, garage, closet, close-up detail, floor plan, map, community amenity, neighborhood or anything else).
Also mark good=1 when the photo is clear, bright and shows the space well, good=0 when it is dark, blurry, a tight close-up or awkwardly cropped.
Answer with JSON only, one entry per photo in order: [[photoNumber,"code",good],...]`;

const shardOf = (id) => 'r' + (Number(String(id).replace(/\D/g, '').slice(-3)) % SHARDS || 0);
const mem = { at: 0, rooms: {} };
async function loadAll() {
  if (Date.now() - mem.at < 5 * 60000) return mem.rooms;
  const docs = await Promise.all(Array.from({ length: SHARDS }, (_, i) => store.readIn(SPACE, 'r' + i).catch(() => null)));
  const rooms = {};
  docs.forEach((d) => Object.assign(rooms, (d && d.doc && d.doc.r) || {}));
  mem.at = Date.now(); mem.rooms = rooms;
  return rooms;
}
async function save(fresh) {
  const byShard = {};
  Object.entries(fresh).forEach(([id, v]) => { (byShard[shardOf(id)] = byShard[shardOf(id)] || {})[id] = v; });
  await Promise.all(Object.entries(byShard).map(([sh, r]) => store.upsert(SPACE, sh, (doc) => { doc.r = Object.assign(doc.r || {}, r); }).catch((e) => console.warn('room save failed', e && e.message))));
  Object.assign(mem.rooms, fresh);
}

// Read one home's photos. Returns { code: [url, ...] } with the best photo first, or null on failure.
async function sortHome(pics, why) {
  why = why || {};
  const key = process.env.ANTHROPIC_API_KEY;
  const list = (pics || []).filter((u) => /^https:\/\/img\.chime\.me\//.test(u)).slice(0, MAX_PICS);
  if (!key || list.length < 2) { why.reason = 'no photos'; return null; }
  const imgs = await Promise.all(list.map(async (u) => {
    const r = await fetch(u.replace('/w800_original_', '/w400_original_'), { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!r || !r.ok) return null;
    const media = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!/^image\/(jpeg|png|webp)$/.test(media)) return null;
    return { media, data: Buffer.from(await r.arrayBuffer()).toString('base64') };
  }));
  const content = [];
  imgs.forEach((im, i) => { if (im) { content.push({ type: 'text', text: 'Photo ' + (i + 1) }); content.push({ type: 'image', source: { type: 'base64', media_type: im.media, data: im.data } }); } });
  if (content.length < 4) { why.reason = 'photo fetch'; return null; }
  content.push({ type: 'text', text: PROMPT });
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 900, messages: [{ role: 'user', content }] }),
      signal: AbortSignal.timeout(45000),
    }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: e.message } }) }));
    if (r.status === 429 || r.status === 529) { await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1))); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { why.reason = 'api ' + r.status + ' ' + (j && j.error && j.error.message); return null; }
    const text = (j.content || []).map((c) => c.text || '').join('');
    const m = text.match(/\[\s*\[[\s\S]*\]\s*\]/);
    if (!m) { why.reason = 'answer ' + text.slice(0, 120); return null; }
    let rows; try { rows = JSON.parse(m[0]); } catch (e) { why.reason = 'json'; return null; }
    const out = {};
    // Good photos first, then in listing order.
    rows.filter((x) => Array.isArray(x) && CODES.includes(x[1]) && list[x[0] - 1]).sort((a, b) => (b[2] ? 1 : 0) - (a[2] ? 1 : 0) || a[0] - b[0])
      .forEach(([n, code, good]) => { if (code === 'other') return; (out[code] = out[code] || []); if (out[code].length < 2 && (good || !out[code].length)) out[code].push(list[n - 1]); });
    if (j.usage) why.usage = j.usage;
    return out;
  }
  why.reason = 'busy';
  return null;
}

// listings: [{ id, pics }]. Sorts the ones not seen before, up to `budget` homes, within `ms`.
async function sortAll(listings, budget, ms) {
  const known = await loadAll();
  const todo = listings.filter((l) => l && l.id && l.pics && l.pics.length > 1 && !known[l.id]).slice(0, budget || 0);
  const fresh = {}, stopAt = Date.now() + (ms || 60000);
  let i = 0, failed = 0;
  await Promise.all(Array.from({ length: Math.min(6, todo.length) }, async () => {
    while (i < todo.length && Date.now() < stopAt) { const l = todo[i++]; const r = await sortHome(l.pics); if (r) fresh[l.id] = r; else failed++; }
  }));
  if (Object.keys(fresh).length) await save(fresh);
  return { sorted: Object.keys(fresh).length, failed, left: Math.max(0, todo.length - Object.keys(fresh).length - failed) };
}

module.exports = { sortHome, sortAll, loadAll, MODEL, CODES };
