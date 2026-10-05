// "What's my home worth?" from StyleDNA. Captures the address as a seller lead in Lofty (or on the
// existing lead), attaches the home to that lead, tells Josh right away, and remembers the home so
// the daily note can compare what they own with what they're browsing.
const store = require('./_lib/boards');
const lofty = require('./_lib/lofty');
const hot = require('./_lib/hot');

const OWNER = Number(process.env.LOFTY_OWNER_ID || 844773861742615);
const clip = (v, n) => (typeof v === 'string' || typeof v === 'number') ? String(v).replace(/\s+/g, ' ').trim().slice(0, n) : '';
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;
const hits = new Map();

async function createSellerLead({ name, email, phone, home, source }) {
  const [firstName, ...rest] = (name || 'Homeowner').split(/\s+/);
  const body = {
    firstName: clip(firstName, 30), lastName: clip(rest.join(' '), 30), emails: [email], leadTypes: [1],
    source: 'StyleDNA Home Value', tags: ['StyleDNA Home Value', 'Seller lead'],
    content: [`Home value request from StyleDNA`, `Home: ${home.full}`, source ? `Came from: ${source}` : ''].filter(Boolean).join('\n'),
    ownershipScope: 'PERSONAL', ownershipId: OWNER, assignedUserId: OWNER,
  };
  if (phone) body.phones = [phone];
  try {
    const r = await fetch('https://api.lofty.com/v1.0/leads', { method: 'POST', headers: { Authorization: 'token ' + process.env.LOFTY_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    const text = await r.text();
    if (!r.ok) { console.warn('seller lead failed', r.status, text.slice(0, 200)); return null; }
    try { return JSON.parse(text).leadId || null; } catch (e) { return null; }
  } catch (e) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600000); list.push(now); hits.set(ip, list);
  if (list.length > 8) return res.status(429).json({ ok: false, error: 'too_many' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ ok: false });
  if (clip(body.website, 50)) return res.status(200).json({ ok: true }); // spam trap

  const street = clip(body.street, 90), city = clip(body.city, 40), zip = clip(body.zip, 10).replace(/[^\d-]/g, '');
  if (!street || (!city && !zip)) return res.status(400).json({ ok: false, error: 'address_required' });
  const home = { address: street, city, zip, full: [street, city, ['TX', zip].filter(Boolean).join(' ')].filter(Boolean).join(', '), at: now };
  const name = clip(body.name, 60), email = clip(body.email, 120).toLowerCase(), phone = clip(body.phone, 20).replace(/\D/g, '');
  const source = clip(body.source, 120);

  // Who is this? Signed lead link, then board member, then email.
  let leadId = null, who = name, boardRef = null;
  const l = body.lead || {};
  if (lofty.leadTokenOk(l.id, l.t)) leadId = Number(l.id);
  const b = body.board || {};
  if (store.validId(b.id) && typeof b.key === 'string') {
    const out = await store.update(b.id, (doc) => {
      const m = (doc.members || []).find((x) => x.key === b.key);
      if (!m) return 'forbidden';
      m.home = home;
      if (!leadId && m.leadId) leadId = m.leadId;
      who = who || m.name; boardRef = { id: doc.id, name: doc.name, pid: m.pid };
      (doc.events = doc.events || []).unshift({ t: now, kind: 'value', by: m.pid, homeId: '', text: `${m.name} asked Josh what their home is worth` });
    });
    if (out && out.result === 'forbidden') boardRef = null;
  }
  if (!leadId && email && EMAIL.test(email)) leadId = await lofty.leadIdByEmail(email);
  let created = false;
  if (!leadId) {
    if (!email || !EMAIL.test(email) || !name) return res.status(400).json({ ok: false, error: 'contact_required' });
    leadId = await createSellerLead({ name, email, phone, home, source });
    created = !!leadId;
    if (!leadId) return res.status(502).json({ ok: false, error: 'crm_error' });
  }
  if (boardRef && leadId) await store.update(boardRef.id, (doc) => { const m = (doc.members || []).find((x) => x.pid === boardRef.pid); if (!m || m.leadId) return false; m.leadId = leadId; });
  if (!boardRef) await store.upsert('visitors', String(leadId), (doc) => { doc.home = home; if (name && !doc.name) doc.name = name; }, () => ({ leadId }));

  await lofty.attachProperty(leadId, { streetAddress: street, city, state: 'TX', zipCode: zip, propertyType: 'Single Family Home' });
  if (!created) await lofty.addNote(leadId, `StyleDNA home value request: ${home.full}${source ? '\nCame from: ' + source : ''}`);
  if (!who) { const L = await lofty.lead(leadId); who = (L && L.name) || 'A StyleDNA lead'; }
  await hot.alert({ kind: 'value', who, leadId, headline: `${who} asked what their home is worth`,
    details: [home.full, created ? 'New seller lead in Lofty.' : 'Added to their existing Lofty lead.', boardRef ? `Board: ${boardRef.name}` : '', email ? 'Email: ' + email : '', phone ? 'Phone: ' + phone : ''].filter(Boolean),
    link: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(home.full) });
  return res.status(200).json({ ok: true, leadId, leadToken: lofty.leadToken(leadId) });
};
