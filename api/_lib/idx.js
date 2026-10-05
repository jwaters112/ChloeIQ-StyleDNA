// joshwaters.com's own listing search (the same lookup its search box uses). Gives address
// suggestions for every active MLS listing, and turns a picked address into the listing itself.
const SITE = 'https://joshwaters.com';
const SITE_ID = 176518;
const HEADERS = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (StyleDNA; +https://homestyledna.com)', Referer: SITE + '/listing' };
const cache = new Map();

async function getJson(url, ms) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < 10 * 60000) return hit.v;
  try {
    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(ms || 5000) });
    last = r.status + ' ' + (r.headers.get('content-type') || '');
    if (!r.ok) { last += ' ' + (await r.text()).slice(0, 200); return null; }
    const v = await r.json();
    if (cache.size > 500) cache.clear();
    cache.set(url, { t: Date.now(), v });
    return v;
  } catch (e) { last = 'ERR ' + (e && e.message); return null; }
}
let last = '';

// "9105 Nor" -> ["9105 Norman DR, Plano, TX 75025", ...]
async function suggest(q) {
  q = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (q.length < 3) return [];
  const j = await getJson(`${SITE}/api-site/search/suggestions/listing/location?siteId=${SITE_ID}&key=${encodeURIComponent(q)}`, 4000);
  if (!Array.isArray(j)) return [];
  const group = j.find((g) => g && g.type === 'streetAddress');
  return ((group && group.list) || []).map((x) => String(x.value || x.label || '').trim()).filter(Boolean).slice(0, 6);
}

const slug = (s) => String(s || '').split(',').slice(0, 2).join(' ').replace(/[^A-Za-z0-9 ]/g, '').trim().replace(/\s+/g, '-');

// Full address -> { id, url, address } for the active listing at that address, or null.
async function findListing(address) {
  address = String(address || '').replace(/\s+/g, ' ').trim().slice(0, 90);
  if (address.length < 6) return null;
  // People type "9105 norman dr plano"; match it to the MLS spelling first.
  let exact = address;
  if (!/,\s*TX\s+\d{5}/i.test(address)) {
    const s = await suggest(address.split(',')[0]);
    const norm = (x) => x.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    const typed = norm(address.split(',')[0]);
    // Only a confident match: same house number and the street they typed.
    const pick = s.find((x) => norm(x).startsWith(typed) && /^\d+/.test(typed));
    if (!pick) return null;
    exact = pick;
  }
  const cond = JSON.stringify({ location: { streetAddress: [exact] } });
  const j = await getJson(`${SITE}/api-site/search/realTimeListings?listingSort=RELEVANCE&page=1&pageSize=3&isSearching=true&siteId=${SITE_ID}&listingSource=all%20listings&condition=${encodeURIComponent(cond)}&uiConfig=%7B%7D&mobile=false&mapSearch=false`, 6000);
  const l = j && Array.isArray(j.listings) && j.listings[0];
  if (!l || !l.id) return null;
  const street = l.streetAddress || exact.split(',')[0];
  const city = l.city || (exact.split(',')[1] || '').trim();
  return { id: String(l.id), url: `${SITE}/listing-detail/${l.id}/${slug(street + ', ' + city + ' TX')}`, address: exact, mls: String(l.mlsListingId || '') };
}

module.exports = { suggest, findListing, lastError: () => last };
