// Lofty API helpers: listing lookups (status, price, photo, open house), lead lookup by email,
// notes on a lead, and the signed lead link used to connect quiz takers to their browsing.
const crypto = require('crypto');

const BASE = 'https://api.lofty.com/v1.0';
const auth = () => ({ Authorization: 'token ' + (process.env.LOFTY_API_KEY || ''), Accept: 'application/json' });

async function call(path, opts) {
  if (!process.env.LOFTY_API_KEY) return null;
  try {
    const r = await fetch((path.startsWith('/v2.0') ? 'https://api.lofty.com' : BASE) + path, Object.assign({ headers: auth(), signal: AbortSignal.timeout(10000) }, opts || {}));
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
    office: String(l.agentOrgName || ''),
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

const jsonPost = (path, body, method) => call(path, { method: method || 'POST', headers: Object.assign(auth(), { 'Content-Type': 'application/json' }), body: JSON.stringify(body) });

// A task on the lead, assigned to Josh. type: Call, Email, Text, Other, Appointment.
// Times are ISO with the Central offset; Lofty shows them on Josh's calendar.
async function createTask(leadId, { content, type, startAt, endAt }) {
  if (!leadId) return null;
  const j = await jsonPost('/v2.0/tasks', { leadId: Number(leadId), content: String(content).slice(0, 500), type: type || 'Call',
    assignedRole: 'Agent', startAt, endAt, timeZoneCode: 'America/Chicago' });
  return j && j.taskId ? j.taskId : null;
}

// Lofty's own record of what a signed-in visitor did on joshwaters.com (newest first).
async function activities(leadId) {
  if (!leadId) return [];
  const j = await call('/leads/' + Number(leadId) + '/activities');
  const list = Array.isArray(j) ? j : (j && (j.activities || j.leadActivities || j.data)) || [];
  return list.map((a) => ({ type: String(a.type || ''), text: String(a.text || ''), link: String(a.link || ''), t: Number(a.created) || 0,
    address: a.listing ? String(a.listing.streetAddress || a.listing.address || a.listing.listingStreetName || '') : '' }));
}

async function lead(leadId) {
  if (!leadId) return null;
  const j = await call('/leads/' + Number(leadId));
  const l = j && (j.lead || j);
  return l && l.leadId ? { leadId: l.leadId, name: [l.firstName, l.lastName].filter(Boolean).join(' '), email: (l.emails || [])[0] || '', phone: (l.phones || [])[0] || '' } : null;
}

async function attachProperty(leadId, p) {
  if (!leadId) return false;
  const j = await jsonPost('/leads/' + Number(leadId) + '/property', Object.assign({ id: 0 }, p));
  return !!j;
}

// Central time helpers for task times.
function ctOffset(d) {
  const s = d.toLocaleString('en-US', { timeZone: 'America/Chicago', timeZoneName: 'shortOffset' });
  const m = s.match(/GMT([+-]\d+)/); const h = m ? Number(m[1]) : -6;
  return (h < 0 ? '-' : '+') + String(Math.abs(h)).padStart(2, '0') + ':00';
}
// ISO time for a Central clock time `days` from now (e.g. 0 days at 17:00).
function ctAt(days, hour, minute) {
  const now = new Date(Date.now() + days * 86400000);
  const ymd = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  return `${ymd}T${String(hour).padStart(2, '0')}:${String(minute || 0).padStart(2, '0')}:00${ctOffset(now)}`;
}

// Stop Lofty's automatic emails (listing alerts, market reports) for a lead. Personal emails still go through.
async function unsubscribe(leadId) {
  if (!leadId) return false;
  const j = await jsonPost('/leads/' + Number(leadId), { unsubscription: true }, 'PUT');
  return !!j;
}
module.exports = { unsubscribe, listingsByMls, listingById, leadIdByEmail, addNote, leadToken, leadTokenOk, createTask, activities, lead, attachProperty, ctAt };
