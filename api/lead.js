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

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const list = (v, n = 20) => (Array.isArray(v) ? v.slice(0, n).map((x) => clip(x, 60)).filter(Boolean) : []);

module.exports = async function handler(req, res) {
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

  // Spam trap: real people never fill this hidden field.
  if (body.website) return res.status(200).json({ ok: true });

  const name = clip(body.name, 60);
  const email = clip(body.email, 120).toLowerCase();
  const phoneDigits = clip(body.phone, 30).replace(/[^\d+]/g, '');
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  }

  const key = process.env.LOFTY_API_KEY;
  if (!key) {
    return res.status(503).json({ ok: false, error: 'not_configured' });
  }

  const [firstName, ...rest] = name.split(/\s+/);
  const lastName = rest.join(' ');
  const archetype = clip(body.archetype, 40);
  const area = clip(body.area, 60);
  const budget = BUDGETS[body.budget] || null;
  const consent = body.consent === true;
  const prefs = body.preferences || {};
  const utm = body.utm || {};
  const loved = list(body.loved);
  const passed = list(body.passed);

  const tags = ['StyleDNA Quiz'];
  if (archetype) tags.push(clip('StyleDNA: ' + archetype, 64));
  if (budget) tags.push(clip('Budget: ' + budget.label, 64));
  if (area) tags.push(clip('Area: ' + area, 64));

  const noteLines = [
    'StyleDNA quiz result',
    'Archetype: ' + (archetype || 'n/a'),
    'Budget: ' + (budget ? budget.label : 'n/a'),
    'Area: ' + (area || 'n/a'),
    'Floor plan: ' + clip(prefs.floorPlan, 20) + ' | Outdoor: ' + clip(prefs.backyard, 20) +
      ' | Kitchen: ' + clip(prefs.kitchen, 20) + ' | Entertaining: ' + clip(prefs.entertaining, 20),
    'Loved styles: ' + (loved.join(', ') || 'none'),
    'Passed styles: ' + (passed.join(', ') || 'none'),
    'Call/text consent: ' + (phoneDigits ? (consent ? 'yes' : 'no') : 'no phone given'),
  ];
  const utmBits = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']
    .filter((k) => utm[k]).map((k) => k.replace('utm_', '') + '=' + clip(utm[k], 60));
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
    if (area) lead.inquiry.locations = [{ description: area, stateCode: 'TX' }];
  }

  try {
    const r = await fetch(LOFTY_URL, {
      method: 'POST',
      headers: { Authorization: 'token ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(lead),
    });
    const text = await r.text();
    if (!r.ok) {
      console.error('Lofty create lead failed', r.status, text.slice(0, 500));
      return res.status(502).json({ ok: false, error: 'crm_error' });
    }
    let leadId = null;
    try { leadId = JSON.parse(text).leadId || null; } catch (e) {}
    return res.status(200).json({ ok: true, leadId });
  } catch (err) {
    console.error('Lofty request error', err && err.message);
    return res.status(502).json({ ok: false, error: 'crm_unreachable' });
  }
};
