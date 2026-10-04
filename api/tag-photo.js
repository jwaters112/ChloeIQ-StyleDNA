// StyleDNA photo tagger: sends a listing's front photo to Claude and returns a style code.
// Runs on Vercel so the Anthropic key never reaches the browser.
// Set ANTHROPIC_API_KEY in Vercel: Project > Settings > Environment Variables.

const MODEL = 'claude-sonnet-5-5';
const MAX_HOMES = 25;

const PROMPT = `You are tagging Dallas-Fort Worth listing photos for a home style quiz.
Look at the photo and answer with JSON only, no other text:
{"ext":"<code>","int":"<code>","note":"<6 words max>"}

ext = the architectural style of the house front. Use one code:
TR Traditional (builder brick or stone, hip and gable roofs, arched entry, typical suburban)
TS Transitional (cleaner modern take on traditional: white or light brick, black windows, simple gables)
MO Modern / Contemporary (flat or shed roofs, big glass, boxy forms, stucco or panel siding)
MF Modern Farmhouse (board and batten or white brick, black trim, metal roof accents, gables)
FH Farmhouse (classic country farmhouse, wraparound porch, dormers)
CR Craftsman (bungalow, tapered porch columns, front gable porch, exposed rafters, prairie foursquare)
TU Tudor (steep cross gables, half-timbering, storybook stone or brick, tall chimneys, modern Tudor)
ME Mediterranean / Spanish (tile roof, stucco, arches)
FR French / European (limestone or stucco, mansard or steep hip roof, chateau, French country)
CO Cottage (small cottage, minimal traditional, painted brick)
MC Mid-Century Modern (low, horizontal, wide eaves, clerestory, 1950s to 1970s modern)
RR Ranch (plain one-story postwar ranch)
HC Hill Country (Texas limestone, metal roof, lodge feel)
CT Colonial / Georgian (symmetrical two-story, columns or pediment, shutters)
IN Industrial (brick loft, steel, warehouse look)
NA the photo is not the house front (interior, aerial, map, floor plan, pool, sign, detail shot)

int = only when ext is NA and the photo is an interior: m modern, l luxe, f farmhouse, s soft transitional, t traditional, r rustic, x dated. Otherwise "-".
Pick the single best code. When unsure between Traditional and something more specific, choose the specific style only if its features are clearly visible.`;

const CODES = new Set(['TR','TS','MO','MF','FH','CR','TU','ME','FR','CO','MC','RR','HC','CT','IN','NA']);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  // Test tool only: refuse on the public site so nobody can spend the API credits.
  // Preview links sit behind Vercel sign-in. The daily run will get its own protected route.
  if (process.env.VERCEL_ENV === 'production') return res.status(404).json({ ok: false, error: 'not_found' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ ok: false, error: 'not_configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const homes = body && Array.isArray(body.homes) ? body.homes.slice(0, MAX_HOMES) : [];
  if (!homes.length) return res.status(400).json({ ok: false, error: 'no_homes' });

  const results = [];
  let i = 0;
  async function worker() {
    while (i < homes.length) {
      const h = homes[i++];
      results.push(await tagOne(key, h));
    }
  }
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);
  // Compact summary in the Vercel logs so a test run can be scored even if the browser tab is lost.
  console.log('tag-results ' + results.map((r) => r.mls + ':' + (r.ext ? r.ext + ':' + r.int : 'ERR:' + r.error)).join(','));
  return res.status(200).json({ ok: true, results });
};

async function tagOne(key, h) {
  const mls = String(h && h.mls || '').slice(0, 20);
  const url = String(h && h.front || '');
  if (!/^https:\/\//.test(url)) return { mls, error: 'bad_url' };
  try {
    const img = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!img.ok) return { mls, error: 'photo_' + img.status };
    const type = (img.headers.get('content-type') || 'image/jpeg').split(';')[0];
    const data = Buffer.from(await img.arrayBuffer()).toString('base64');
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 80,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: type, data } },
          { type: 'text', text: PROMPT },
        ] }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json();
    if (!r.ok) return { mls, error: 'api_' + r.status, detail: j && j.error && j.error.message };
    const text = (j.content || []).map((c) => c.text || '').join('');
    const m = text.match(/\{[\s\S]*\}/);
    const out = m ? JSON.parse(m[0]) : {};
    const ext = CODES.has(out.ext) ? out.ext : 'NA';
    return { mls, ext, int: out.int || '-', note: String(out.note || '').slice(0, 60),
             usage: j.usage ? { in: j.usage.input_tokens, out: j.usage.output_tokens } : null };
  } catch (e) {
    return { mls, error: 'failed', detail: e && e.message };
  }
}
