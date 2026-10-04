// StyleDNA quiz -> Lofty CRM.
// Runs on Vercel as a serverless function so the Lofty API key never reaches the browser.
// Set LOFTY_API_KEY in Vercel: Project > Settings > Environment Variables.

const LOFTY_URL = 'https://api.lofty.com/v1.0/leads';

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
const MIN_QUIZ_SECONDS = 20; // a real person can't finish 12 swipes, 5 steps and the form faster
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

  const tags = ['StyleDNA Quiz'];
  if (archetype) tags.push(clip('StyleDNA: ' + archetype, 64));
  if (budget) tags.push(clip('Budget: ' + budget.label, 64));
  if (area) tags.push(clip('Area: ' + area, 64));
  if (homeType) tags.push(clip('Home type: ' + homeType, 64));
  if (partnerArch) tags.push('Partner compare');

  const noteLines = [
    'StyleDNA quiz result',
    'Archetype: ' + (archetype || 'n/a'),
    'Budget: ' + (budget ? budget.label : 'n/a'),
    'Area: ' + (area || 'n/a'),
    'Home type: ' + (homeType || 'open to any'),
    'Floor plan: ' + clip(prefs.floorPlan, 20) + ' | Outdoor: ' + clip(prefs.backyard, 20) +
      ' | Kitchen: ' + clip(prefs.kitchen, 20) + ' | Entertaining: ' + clip(prefs.entertaining, 20),
    'Loved styles: ' + (loved.join(', ') || 'none'),
    'Passed styles: ' + (passed.join(', ') || 'none'),
    'Call/text consent: ' + (phoneDigits ? (consent ? 'yes' : 'no') : 'no phone given'),
  ];
  const utmBits = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']
    .filter((k) => utm[k]).map((k) => k.replace('utm_', '') + '=' + clip(utm[k], 60));
  if (dream) noteLines.splice(1, 0, 'In their words: "' + dream + '"');
  if (partnerArch) noteLines.push('Compared with: ' + (partnerName || 'a partner') + ' (' + partnerArch + ')');
  if (utmBits.length) noteLines.push('Came from: ' + utmBits.join(', '));

  const lead = {
    firstName: clip(firstName, 30),
    lastName: clip(lastName, 30),
    emails: [email],
    leadTypes: [2],
    source: 'StyleDNA Quiz',
    tags,
    content: noteLines.join('\n').slice(0, 2000),
    ownershipScope: 'PERSONAL',
  };
  if (phoneDigits) {
    lead.phones = [clip(phoneDigits, 20)];
    if (!consent) { lead.cannotCall = true; lead.cannotText = true; }
  }
  if (budget || area) {
    lead.inquiry = {};
    if (budget && budget.priceMin) lead.inquiry.priceMin = budget.priceMin;
    if (budget && budget.priceMax) lead.inquiry.priceMax = budget.priceMax;
    if (area) {
      lead.inquiry.locations = AREA_ZIPS[area]
        ? AREA_ZIPS[area].map((z) => ({ zipCode: z, stateCode: 'TX', description: area }))
        : [{ city: area, stateCode: 'TX', description: area }];
    }
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
    return res.status(200).json({ ok: true, leadId });
  } catch (err) {
    console.error('Lofty request error', err && err.message);
    return res.status(502).json({ ok: false, error: 'crm_unreachable' });
  }
}
