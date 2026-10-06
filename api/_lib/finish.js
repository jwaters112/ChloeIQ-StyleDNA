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
      body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: 'user', content }] }), signal: AbortSignal.timeout(25000),
    }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: e.message } }) }));
    if (r.status === 429 || r.status === 529) { await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1))); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { why.reason = 'api ' + r.status + ' ' + (j && j.error && j.error.message); return null; }
    const text = (j.content || []).map((c) => c.text || '').join('');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) { why.reason = 'answer'; return null; }
    try { why.usage = j.usage; why.model = model; return JSON.parse(m[0]); } catch (e) { why.reason = 'json'; return null; }
  }
  why.reason = 'busy';
  return null;
}
module.exports = { readFinishes, MODELS };
