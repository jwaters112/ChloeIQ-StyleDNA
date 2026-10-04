// Lofty API helpers: listing lookups (status, price, photo, open house), lead lookup by email,
// notes on a lead, and the signed lead link used to connect quiz takers to their browsing.
const crypto = require('crypto');

const BASE = 'https://api.lofty.com/v1.0';
const auth = () => ({ Authorization: 'token ' + (process.env.LOFTY_API_KEY || ''), Accept: 'application/json' });

async function call(path, opts) {
  if (!process.env.LOFTY_API_KEY) return null;
  try {
    const r = await fetch(BASE + path, Object.assign({ headers: auth(), signal: AbortSignal.timeout(10000) }, opts || {}));
    const text = await r.text();
    if (!r.ok) { console.warn('lofty', path.split('?')[0], r.status, text.slice(0, 200)); return null; }
    try { return JSON.parse(text); } catch (e) { return null; }
  } catch (e) { console.warn('lofty call failed', e && e.message); return null; }
}

const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[^\d.]/g, '')); return Number.isFinite(n) && n > 0 ? n : 0; };

function normalize(l, sold) {
  if (!l) return null;
  const zip = Array.isArray(l.listingZipcode) ? l.listingZipcode[0] : (l.listingZipcode || '');
  const street = l.listingStreetName || l.streetAddress || '';
  return {
    listingId: String(l.listingId || ''),
    mls: String(l.mlsListingId || ''),
    status: sold ? 'Sold' : String(l.listingStatus || 'Active'),
    price: num(sold ? (l.soldPrice || l.closePrice || l.price) : l.price),
    address: [street, l.listingCity, [l.listingState, zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    city: l.listingCity || '',
    beds: l.beds ? String(Math.round(l.beds)) : '',
    baths: l.baths ? String(l.baths).replace(/\.0$/, '') : '',
    sqft: l.sqft ? String(Math.round(l.sqft)) : '',
    photo: Array.isArray(l.pictureList) && l.pictureList[0] ? String(l.pictureList[0]) : '',
    openHouse: l.openHouseSchedulesStart ? { start: String(l.openHouseSchedulesStart), end: String(l.openHouseSchedulesEnd || ''), text: String(l.openHouseSchedules || '') } : null,
  };
}

function collect(j) {
  const out = [];
  if (!j) return out;
  (j.listIng || j.listing || []).forEach((l) => { const n = normalize(l, false); if (n) out.push(n); });
  (j.soldListing || []).forEach((l) => { const n = normalize(l, true); if (n) out.push(n); });
  return out;
}

// Look up many MLS numbers at once (in chunks). Returns a map mls -> listing.
async function listingsByMls(mlsList) {
  const map = {};
  let answered = 0;
  const list = [...new Set((mlsList || []).map((m) => String(m).replace(/\D/g, '')).filter(Boolean))];
  for (let i = 0; i < list.length; i += 40) {
    const chunk = list.slice(i, i + 40);
    const j = await call('/listing?limit=100&mlsListingIds=' + encodeURIComponent(chunk.join(',')));
    if (j) answered++;
    collect(j).forEach((l) => { if (l.mls) map[l.mls] = l; });
  }
  // ok = Lofty answered every lookup, so a missing listing really is off the market (not an outage).
  Object.defineProperty(map, '__ok', { value: answered === Math.ceil(list.length / 40), enumerable: false });
  return map;
}

async function listingById(listingId) {
  const id = String(listingId || '').replace(/\D/g, '');
  if (!id) return null;
  const j = await call('/listing?limit=1&listingId=' + id);
  return collect(j)[0] || null;
}

async function leadIdByEmail(email) {
  if (!email) return null;
  const j = await call('/leads?limit=5&keyword=' + encodeURIComponent(email));
  const hit = j && (j.leads || []).find((l) => (l.emails || []).some((e) => String(e).toLowerCase() === String(email).toLowerCase()));
  return hit ? hit.leadId : null;
}

async function addNote(leadId, content) {
  if (!leadId || !content) return false;
  const j = await call('/notes', { method: 'POST', headers: Object.assign(auth(), { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ leadId: Number(leadId), content: String(content).slice(0, 2000), isPin: false }) });
  return !!j;
}

// Signed lead link: lets a browser prove which Lofty lead it belongs to without exposing anything else.
const secret = () => process.env.LEAD_LINK_SECRET || crypto.createHash('sha256').update('sdna-lead|' + (process.env.BLOB_READ_WRITE_TOKEN || 'dev')).digest('hex');
const leadToken = (leadId) => crypto.createHmac('sha256', secret()).update(String(leadId)).digest('base64url').slice(0, 16);
const leadTokenOk = (leadId, token) => !!leadId && /^\d{6,20}$/.test(String(leadId)) && typeof token === 'string' && token.length === 16
  && crypto.timingSafeEqual(Buffer.from(leadToken(leadId)), Buffer.from(token));

module.exports = { listingsByMls, listingById, leadIdByEmail, addNote, leadToken, leadTokenOk };
