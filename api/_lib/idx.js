// joshwaters.com's own listing search (the same lookup its search box uses). Gives address
// suggestions for every active MLS listing, and turns a picked address into the listing itself.
const SITE = 'https://joshwaters.com';
const SITE_ID = 176518;
const HEADERS = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (StyleDNA; +https://homestyledna.com)', Referer: SITE + '/listing' };
const cache = new Map();

async function getJson(url, ms, again) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < 10 * 60000) return hit.v;
  try {
    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(ms || 5000) });
    last = r.status + ' ' + (r.headers.get('content-type') || '');
    const text = await r.text();
    if (!r.ok) { last += ' ' + text.slice(0, 200); console.warn('idx lookup failed', last); return null; }
    let v; try { v = JSON.parse(text); } catch (e) { last += ' not json: ' + text.slice(0, 200); console.warn('idx lookup not json', last); return null; }
    if (!Array.isArray(v) && !(v && v.listings)) { console.warn('idx lookup odd', text.slice(0, 300)); return again ? v : getJson(url, ms, true); }
    if (cache.size > 500) cache.clear();
    cache.set(url, { t: Date.now(), v });
    return v;
  } catch (e) { last = 'ERR ' + (e && e.message); console.warn('idx lookup error', last); return again ? null : getJson(url, ms, true); }
}
let last = '';

// "9105 Nor" -> ["9105 Norman DR, Plano, TX 75025", ...]
async function suggest(q) {
  q = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (q.length < 3) return [];
  const j = await getJson(`${SITE}/api-site/search/suggestions/listing/location?siteId=${SITE_ID}&key=${encodeURIComponent(q)}`, 6000);
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

// ---- listing search (the same search the site's results page runs) ----
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : 0; };
const photoUrl = (u) => String(u || '').split('?')[0].replace('/original_', '/w600_original_');
function slim(l) {
  const m = (l && l.multiFieldsJson && typeof l.multiFieldsJson === 'object') ? l.multiFieldsJson : {};
  const street = l.streetAddress || '', city = l.city || '', zip = l.zipCode || '';
  const path = l.detailUrl || `/listing-detail/${l.id}/${slug(street + ', ' + city + ' TX')}`;
  return {
    id: String(l.id), mls: String(l.mlsListingId || ''), url: SITE + (path.startsWith('/') ? path : '/' + path),
    address: [street, city, ['TX', zip].filter(Boolean).join(' ')].filter(Boolean).join(', '), street, city, county: l.county || '', zip,
    price: num(l.price), beds: num(l.bedrooms), baths: num(l.bathrooms), sqft: num(l.sqft), built: num(l.builtYear),
    photo: photoUrl(l.previewPicture), office: l.agentOrganizationName || '',
    lat: num(l.latitude), lng: num(l.longitude),
    acres: num(m.chimeLotAcreage), pool: /yes/i.test(m.chimePrivatePoolFlag || m.chimePool || ''),
    stories: String(m.chimeStory || ''), hoa: /yes/i.test(m.chimeHoaFlag || ''), materials: String(m.chimeMaterials || ''),
    remarks: String(l.detailsDescribe || '').toLowerCase().slice(0, 1500),
  };
}
// cond: the site's search condition. Returns { count, list } or null when the site didn't answer.
async function search(cond, pageSize, page) {
  const c = Object.assign({ purchasetype: ['For Sale'] }, cond);
  const url = `${SITE}/api-site/search/realTimeListings?listingSort=RELEVANCE&page=${page || 1}&pageSize=${pageSize || 12}&isSearching=true&siteId=${SITE_ID}&listingSource=all%20listings&condition=${encodeURIComponent(JSON.stringify(c))}&uiConfig=%7B%7D&mobile=false&mapSearch=false`;
  const j = await getJson(url, 8000);
  if (!j || !Array.isArray(j.listings)) return null;
  return { count: Number(j.counts) || 0, list: j.listings.filter((l) => l && l.id && l.previewPicture).map(slim) };
}
// A joshwaters.com results page for the same condition, so "see them all" opens the real search.
function searchUrl(cond) {
  const c = Object.assign({ purchasetype: ['For Sale'] }, cond);
  return `${SITE}/listing?listingSource=${encodeURIComponent('all listings')}&condition=${encodeURIComponent(JSON.stringify(c))}&page=1`;
}

module.exports = { suggest, findListing, search, searchUrl, slim, lastError: () => last };
