// Reads finishes from a home's inside photos (kitchen, living room, primary bath): cabinet color,
// counters, floors, carpet, island, ceilings, fixtures, tub and shower, and how updated it looks.
// One call per home with up to three photos. Anything not clearly visible comes back "unclear".
const MODELS = { sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-4-5-20251001' };
const PROMPT = `These are photos of one home for sale: the kitchen, the main living room and the primary bathroom (some may be missing).
Describe the finishes you can actually see. If something is not clearly visible, answer "unclear". Do not guess.
Answer with JSON only, exactly these keys:
{"cabinets":"white|light wood|medium wood|dark wood|gray|black|blue or green|two-tone|unclear",
"counters":"white or light stone|dark stone|speckled granite|butcher block|laminate|unclear",
"floors":"wood|wood-look tile|tile|carpet|stone|concrete|unclear",
"carpet_living":true|false|"unclear",
"island":true|false|"unclear",
"open_kitchen":true|false|"unclear",
"ceilings":"standard|tall|vaulted|beamed|unclear",
"fixtures":"gold or brass|black|silver or nickel|mixed|unclear",
"tub":"freestanding|built-in|none|unclear",
"shower":"walk-in glass|tub and shower combo|unclear",
"look":"new or recently updated|partly updated|original or dated|unclear"}
floors means the main floor in the living room. open_kitchen means the kitchen opens to the living area.`;

async function readFinishes(rooms, modelKey, why) {
  why = why || {};
  const key = process.env.ANTHROPIC_API_KEY;
  const model = MODELS[modelKey] || MODELS.sonnet;
  const order = ['kitchen', 'living', 'primary_bath'];
  const urls = order.map((k) => rooms && rooms[k]).filter((u) => typeof u === 'string' && /^https:\/\/img\.chime\.me\//.test(u));
  if (!key || urls.length < 2) { why.reason = 'not enough inside photos'; return null; }
  const imgs = await Promise.all(urls.map(async (u) => {
    const r = await fetch(u.replace('/w800_original_', '/w600_original_'), { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!r || !r.ok) return null;
    const media = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!/^image\/(jpeg|png|webp)$/.test(media)) return null;
    return { media, data: Buffer.from(await r.arrayBuffer()).toString('base64') };
  }));
  const content = [];
  imgs.forEach((im, i) => { if (im) { content.push({ type: 'text', text: ['Kitchen', 'Living room', 'Primary bathroom'][order.indexOf(order.find((k) => rooms[k] === urls[i]))] || 'Photo' }); content.push({ type: 'image', source: { type: 'base64', media_type: im.media, data: im.data } }); } });
  if (content.length < 4) { why.reason = 'photo fetch'; return null; }
  content.push({ type: 'text', text: PROMPT });
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1500, ...(modelKey === 'haiku' ? {} : { thinking: { type: 'between_tools' } }), messages: [{ role: 'user', content }] }), signal: AbortSignal.timeout(25000),
    }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: e.message } }) }));
    if (r.status === 429 || r.status === 529) { await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1))); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { why.reason = 'api ' + r.status + ' ' + (j && j.error && j.error.message); return null; }
    const text = (j.content || []).map((c) => c.text || '').join('');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) { why.reason = 'answer ' + (j.stop_reason || '') + ' ' + JSON.stringify((j.content || []).map((c) => c.type)) + ' ' + text.slice(0, 160); return null; }
    try { why.usage = j.usage; why.model = model; return JSON.parse(m[0]); } catch (e) { why.reason = 'json'; return null; }
  }
  why.reason = 'busy';
  return null;
}
// ---- stored readings, one small record per listing, sharded like the room sort ----
const store = require('./boards');
const SPACE = 'fin1', SHARDS = 10;
const shardOf = (id) => 'fin' + (Number(String(id).replace(/\D/g, '').slice(-3)) % SHARDS || 0);
const mem = { at: 0, all: {} };
async function loadAll() {
  if (Date.now() - mem.at < 5 * 60000) return mem.all;
  const docs = await Promise.all(Array.from({ length: SHARDS }, (_, i) => store.readIn(SPACE, 'fin' + i).catch(() => null)));
  const all = {}; docs.forEach((d) => Object.assign(all, (d && d.doc && d.doc.f) || {}));
  mem.at = Date.now(); mem.all = all; return all;
}
// Keep only the finishes the site uses, in short form.
const slimTags = (t) => ({ cab: t.cabinets || 'unclear', carpet: t.carpet_living, island: t.island, look: t.look || 'unclear', at: Date.now() });
async function save(fresh) {
  const by = {}; Object.entries(fresh).forEach(([id, v]) => { (by[shardOf(id)] = by[shardOf(id)] || {})[id] = v; });
  await Promise.all(Object.entries(by).map(([sh, f]) => store.upsert(SPACE, sh, (doc) => { doc.f = Object.assign(doc.f || {}, f); }).catch((e) => console.warn('finish save failed', e && e.message))));
  Object.assign(mem.all, fresh);
}
// homes: [{ id, rooms }]. Reads the ones not read yet, up to budget, within ms.
async function readAll(homes, budget, ms) {
  const known = await loadAll();
  const todo = homes.filter((h) => h && h.id && h.rooms && !known[h.id]).slice(0, budget || 0);
  const fresh = {}, stopAt = Date.now() + (ms || 60000);
  let i = 0, failed = 0, inTok = 0, outTok = 0;
  await Promise.all(Array.from({ length: Math.min(6, todo.length) }, async () => {
    while (i < todo.length && Date.now() < stopAt) {
      const h = todo[i++], why = {};
      const t = await readFinishes(h.rooms, 'sonnet', why);
      if (why.usage) { inTok += why.usage.input_tokens || 0; outTok += why.usage.output_tokens || 0; }
      if (t) fresh[h.id] = slimTags(t);
      else if (why.reason === 'not enough inside photos') fresh[h.id] = { none: 1, at: Date.now() };
      else failed++;
    }
  }));
  if (Object.keys(fresh).length) await save(fresh);
  return { read: Object.keys(fresh).length, failed, left: Math.max(0, todo.length - Object.keys(fresh).length - failed), inTok, outTok };
}
module.exports = { readFinishes, MODELS, loadAll, readAll };
