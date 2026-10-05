// StyleDNA quiz -> Lofty CRM.
// Runs on Vercel as a serverless function so the Lofty API key never reaches the browser.
// Set LOFTY_API_KEY in Vercel: Project > Settings > Environment Variables.

const LOFTY_URL = 'https://api.lofty.com/v1.0/leads';
const lofty = require('./_lib/lofty');
const store = require('./_lib/boards');
const deckLib = require('./_lib/deck');

async function rememberSharer(sid, leadId, name) {
  sid = String(sid || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
  if (!sid || sid.length < 8 || !leadId) return;
  try { await store.upsert('sharers', sid, (doc) => { doc.leadId = leadId; doc.name = name; }); } catch (e) {}
}

async function linkMember(mem, leadId) {
  mem = mem || {};
  if (!leadId || !store.validId(mem.id) || typeof mem.key !== 'string') return;
  try {
    await store.update(mem.id, (b) => {
      const m = (b.members || []).find((x) => x.key === mem.key);
      if (!m || m.leadId === leadId) return false;
      m.leadId = leadId;
    });
  } catch (e) { console.warn('link lead to board failed', e && e.message); }
}
// Josh's Lofty user id (the owner on every existing lead). Lofty refuses PERSONAL leads without it.
const LOFTY_OWNER_ID = Number(process.env.LOFTY_OWNER_ID || 844773861742615);

const BUDGETS = {
  0: { label: 'Under $300K', priceMax: 300000 },
  1: { label: '$300K to $500K', priceMin: 300000, priceMax: 500000 },
  2: { label: '$500K to $750K', priceMin: 500000, priceMax: 750000 },
  3: { label: '$750K to $1M', priceMin: 750000, priceMax: 1000000 },
  4: { label: '$1M+', priceMin: 1000000 },
};

// Neighborhoods that are not cities map to ZIP codes so Lofty search criteria match real listings.
const AREA_ZIPS = {
  'Uptown': ['75201', '75204'], 'Downtown Dallas': ['75201', '75202'], 'Preston Hollow': ['75225', '75229', '75230'],
  'Bishop Arts': ['75208'], 'Lakewood': ['75214'], 'Lake Highlands': ['75238', '75243'], 'M Streets': ['75206'],
  'Oak Lawn': ['75219'], 'Oak Cliff': ['75208', '75211', '75224'], 'Deep Ellum': ['75226'], 'Knox-Henderson': ['75205', '75206'],
  'Turtle Creek': ['75219'], 'Devonshire': ['75209'],
  'TCU/West Cliff': ['76109', '76110'], 'Tanglewood': ['76109'], 'Rivercrest': ['76107'], 'Cultural District': ['76107'],
  'Near Southside': ['76104'], 'Mistletoe Heights': ['76104'], 'Downtown Fort Worth': ['76102'],
  'Las Colinas': ['75038', '75039', '75063'],
};

// Spam limits. Serverless instances are short-lived, so these are a best-effort first line;
// the honeypot and the too-fast check below catch most bots on their own.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_PER_IP = 5;
const MIN_QUIZ_SECONDS = 25; // a real person can't finish 20 swipes, 4 steps and the form faster
const recentByIp = new Map();
const recentEmails = new Map();

function overLimit(ip, now) {
  const hits = (recentByIp.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  recentByIp.set(ip, hits);
  if (recentByIp.size > 5000) recentByIp.clear();
  return hits.length > RATE_MAX_PER_IP;
}

const clip = (v, n) => (typeof v === 'string' || typeof v === 'number') ? String(v).trim().slice(0, n) : '';
const list = (v, n = 20) => (Array.isArray(v) ? v.slice(0, n).map((x) => clip(x, 60)).filter(Boolean) : []);

module.exports = async function handler(req, res) {
  try {
    return await handle(req, res);
  } catch (err) {
    console.error('lead handler error', err && err.message);
    return res.status(400).json({ ok: false, error: 'bad_request' });
  }
};

async function handle(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'bad_request' });
  }

  // Spam trap: real people never fill this hidden field. Every silent drop is logged so a real
  // person caught by mistake shows up in the Vercel logs.
  const dropDomain = String(body.email || '').split('@')[1] || 'none';
  if (body.website) {
    console.warn('lead dropped: trap field filled', { domain: dropDomain });
    return res.status(200).json({ ok: true });
  }
  // Finished the whole quiz in under 20 seconds: a bot. Answer ok so it doesn't retry.
  const elapsed = Number(body.elapsed);
  if (body.elapsed !== null && body.elapsed !== undefined && Number.isFinite(elapsed) && elapsed < MIN_QUIZ_SECONDS) {
    console.warn('lead dropped: too fast', { elapsed, domain: dropDomain });
    return res.status(200).json({ ok: true });
  }
  const now = Date.now();
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (overLimit(ip, now)) {
    console.warn('lead refused: rate limit', { domain: dropDomain });
    return res.status(429).json({ ok: false, error: 'too_many' });
  }

  const name = clip(body.name, 60);
  const email = clip(body.email, 120).toLowerCase();
  const phoneRaw = clip(body.phone, 30).replace(/[^\d+]/g, '');
  const phoneDigits = phoneRaw.replace(/\D/g, '').length >= 10 ? phoneRaw : '';
  if (!name || !/^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i.test(email)) {
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  }

  // Same email again within 10 minutes (double submit, back button): don't create a second lead.
  const seen = recentEmails.get(email);
  if (seen && now - seen < RATE_WINDOW_MS) return res.status(200).json({ ok: true, duplicate: true });

  const key = process.env.LOFTY_API_KEY;
  if (!key) {
    return res.status(503).json({ ok: false, error: 'not_configured' });
  }

  const [firstName, ...rest] = name.split(/\s+/);
  const lastName = rest.join(' ');
  const archetype = clip(body.archetype, 40);
  const area = clip(body.area, 60);
  // Every area they picked (the form's area first), at most 6.
  const areas = [...new Set([area, ...(Array.isArray(body.areas) ? body.areas : []).map((a) => clip(a, 60))].filter(Boolean))].slice(0, 6);
  const budgetKey = Number(body.budget);
  const budget = Number.isInteger(budgetKey) && Object.prototype.hasOwnProperty.call(BUDGETS, budgetKey) ? BUDGETS[budgetKey] : null;
  const consent = body.consent === true;
  const prefs = (body.preferences && typeof body.preferences === 'object') ? body.preferences : {};
  const utm = (body.utm && typeof body.utm === 'object') ? body.utm : {};
  const loved = list(body.loved);
  const passed = list(body.passed);
  const homeType = clip(body.homeType, 30);
  const dream = clip(body.dream, 300).replace(/\s+/g, ' ');
  const partner = (body.partner && typeof body.partner === 'object') ? body.partner : null;
  const partnerName = partner ? clip(partner.name, 24) : '';
  const partnerArch = partner ? clip(partner.archetype, 40) : '';

  // StyleDNA v2: architectural style from real homes, must-haves and quick picks.
  const crit = deckLib.criteria(body.search || {});
  const styleNext = clip(body.styleNext, 40);
  const MUST_LABEL = { pool: 'Pool', acres: '1+ acre', gameroom: 'Game or media room', suite: 'Guest suite or in-law quarters', access: 'Accessible features' };
  const PICK_LABEL = { exterior: { brick: 'Brick', stone: 'Stone', stucco: 'Stucco', siding: 'Siding' }, layout: { open: 'Open concept', separate: 'Separate rooms' },
    condition: { ready: 'Move-in ready', updates: 'Some updates OK', project: 'Open to a project' }, hoa: { no: 'No HOA', yes: 'HOA preferred' }, setting: { near: 'Close to shops and dining', secluded: 'Secluded, more privacy' } };
  const musts = Object.entries(crit.must).filter(([, v]) => v === 'must').map(([k]) => MUST_LABEL[k]);
  const nices = Object.entries(crit.must).filter(([, v]) => v === 'nice').map(([k]) => MUST_LABEL[k]);
  const picks = Object.entries(crit.picks).map(([k, v]) => PICK_LABEL[k] && PICK_LABEL[k][v]).filter(Boolean);
  const lovedHomes = (Array.isArray(body.lovedHomes) ? body.lovedHomes : []).slice(0, 12)
    .map((h) => h && typeof h === 'object' ? { label: clip(h.label, 40), address: clip(h.address, 90), url: /^https:\/\/joshwaters\.com\//.test(String(h.url || '')) ? clip(h.url, 300) : '' } : null).filter((h) => h && h.address);
  const where = [crit.counties.length ? crit.counties.join(', ') + (crit.counties.length > 1 ? ' counties' : ' County') : '', crit.cities.join(', ')].filter(Boolean).join(': ');

  const tags = ['StyleDNA Quiz'];
  if (archetype) tags.push(clip('StyleDNA: ' + archetype, 64));
  if (budget) tags.push(clip('Budget: ' + budget.label, 64));
  areas.forEach((a) => tags.push(clip('Area: ' + a, 64)));
  crit.counties.forEach((c) => tags.push(clip('County: ' + c, 64)));
  musts.forEach((m) => tags.push(clip('Must have: ' + m, 64)));
  if (homeType) tags.push(clip('Home type: ' + homeType, 64));
  if (body.buildOpen === true) tags.push('Open to build or renovate');
  if (partnerArch) tags.push('Partner compare');
  if (clip(body.board, 24)) tags.push('Home board');

  const noteLines = [
    'StyleDNA quiz result',
    'Home style: ' + (archetype || 'n/a') + (styleNext ? ', leans ' + styleNext : '') + (clip(body.signature, 60) ? ' (' + clip(body.signature, 60) + ')' : ''),
    ...(clip(body.inside, 80) ? ['Inside they love: ' + clip(body.inside, 80)] : []),
    ...(body.buildOpen === true ? ['Open to building new or renovating to be in: ' + (where || 'their area') + '. Connect with builders or contractors.'] : body.buildOpen === false ? ['Not open to building or renovating.'] : []),
    'Budget: ' + (budget ? budget.label : 'n/a'),
    'Looking in: ' + (where || areas.join(', ') || 'anywhere in DFW'),
    'Home type: ' + (homeType || 'open to any'),
    'Must have: ' + (musts.join(', ') || 'nothing required'),
    nices.length ? 'Nice to have: ' + nices.join(', ') : '',
    picks.length ? 'Picks: ' + picks.join(', ') : '',
    lovedHomes.length ? 'Homes they loved in the quiz:\n' + lovedHomes.map((h) => `- ${h.label ? h.label + ': ' : ''}${h.address}${h.url ? ' ' + h.url : ''}`).join('\n') : 'Loved: none',
    passed.length ? 'Passed on: ' + [...new Set(passed)].join(', ') : '',
    'Call/text consent: ' + (phoneDigits ? (consent ? 'yes' : 'no') : 'no phone given'),
  ].filter(Boolean);
  // Their top matches on the market right now, so Josh can open the call with real homes.
  const styleKey = clip(body.style, 20);
  if (styleKey) {
    try {
      const av = await Promise.race([deckLib.availability(body.search || {}, styleKey), new Promise((ok) => setTimeout(() => ok(null), 4000))]);
      if (av && av.ok) {
        noteLines.push(`${av.label} homes for sale in their search right now: ${av.count}`);
        if (av.homes.length) noteLines.push('Best fits:\n' + av.homes.slice(0, 3).map((h) => `- ${h.address}, $${Number(h.price).toLocaleString('en-US')}${h.hits.length ? ' (' + h.hits.join(', ') + ')' : ''} ${h.url}`).join('\n'));
        if (av.nearest) noteLines.push(`Few in their areas. Closest place with ${av.label} homes: ${av.nearest.city}`);
      }
    } catch (e) {}
  }
  const utmBits = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']
    .filter((k) => utm[k]).map((k) => k.replace('utm_', '') + '=' + clip(utm[k], 60));
  if (dream) noteLines.splice(1, 0, 'In their words: "' + dream + '"');
  if (partnerArch) noteLines.push('Compared with: ' + (partnerName || 'a partner') + ' (' + partnerArch + ')');
  const boardId = clip(body.board, 24).replace(/[^A-Za-z0-9]/g, '');
  if (boardId) noteLines.push('Home board: https://homestyledna.com/board.html?id=' + boardId);
  const srcLabel = clip(body.source, 120);
  if (srcLabel) noteLines.push('Came from: ' + srcLabel);
  else if (utmBits.length) noteLines.push('Came from: ' + utmBits.join(', '));
  const referredBy = clip(body.referredBy, 16).replace(/[^A-Za-z0-9]/g, '');
  if (referredBy) {
    try { const sh = await store.readIn('sharers', referredBy); if (sh && sh.doc.name) noteLines.push('Shared to them by: ' + sh.doc.name + (sh.doc.leadId ? ' (Lofty lead ' + sh.doc.leadId + ')' : '')); } catch (e) {}
  }

  const lead = {
    firstName: clip(firstName, 30),
    lastName: clip(lastName, 30),
    emails: [email],
    leadTypes: [2],
    source: 'StyleDNA Quiz',
    tags,
    content: noteLines.join('\n').slice(0, 2000),
    ownershipScope: 'PERSONAL',
    ownershipId: LOFTY_OWNER_ID,
    assignedUserId: LOFTY_OWNER_ID,
  };
  if (phoneDigits) {
    lead.phones = [clip(phoneDigits, 20)];
    if (!consent) { lead.cannotCall = true; lead.cannotText = true; }
  }
  if (budget || areas.length) {
    lead.inquiry = {};
    if (budget && budget.priceMin) lead.inquiry.priceMin = budget.priceMin;
    if (budget && budget.priceMax) lead.inquiry.priceMax = budget.priceMax;
    if (areas.length) {
      lead.inquiry.locations = areas.flatMap((a) => (AREA_ZIPS[a]
        ? AREA_ZIPS[a].map((z) => ({ zipCode: z, stateCode: 'TX', description: a }))
        : [{ city: a, stateCode: 'TX', description: a }]));
    }
  }

  // Already in Lofty (retake, second device, partner using the same email): add the new result as a
  // note on the existing lead instead of creating a duplicate.
  const existing = await lofty.leadIdByEmail(email);
  if (existing) {
    await lofty.addNote(existing, ['StyleDNA quiz taken again', ...noteLines.slice(1)].join('\n'));
    recentEmails.set(email, now);
    await linkMember(body.member, existing);
    await rememberSharer(body.sid, existing, name);
    return res.status(200).json({ ok: true, leadId: existing, existing: true, leadToken: lofty.leadToken(existing) });
  }

  try {
    const r = await fetch(LOFTY_URL, {
      method: 'POST',
      headers: { Authorization: 'token ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(lead),
      signal: AbortSignal.timeout(8000),
    });
    const text = await r.text();
    if (!r.ok) {
      console.error('Lofty create lead failed', r.status, text.slice(0, 500));
      return res.status(502).json({ ok: false, error: 'crm_error' });
    }
    recentEmails.set(email, now);
    if (recentEmails.size > 5000) recentEmails.clear();
    let leadId = null;
    try { leadId = JSON.parse(text).leadId || null; } catch (e) {}
    if (!leadId) leadId = await lofty.leadIdByEmail(email);
    // Already on a board in this browser: tie that board member to this Lofty lead.
    await linkMember(body.member, leadId);
    await rememberSharer(body.sid, leadId, name);
    return res.status(200).json({ ok: true, leadId, leadToken: leadId ? lofty.leadToken(leadId) : '' });
  } catch (err) {
    console.error('Lofty request error', err && err.message);
    return res.status(502).json({ ok: false, error: 'crm_unreachable' });
  }
}
