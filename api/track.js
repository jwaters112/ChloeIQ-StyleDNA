// Browsing log from joshwaters.com for visitors who came in through StyleDNA.
// The Save button script sends what they view, search, heart and request. Board members are
// identified by their board key; quiz takers without a board by their signed Lofty lead link.
const store = require('./_lib/boards');
const lofty = require('./_lib/lofty');

const MAX = 400;
const KINDS = ['view', 'time', 'search', 'heart', 'save', 'tour', 'contact'];
const ORIGINS = ['https://joshwaters.com', 'https://www.joshwaters.com'].concat(process.env.BOARD_STORE_DIR && process.env.EXTRA_ORIGIN ? [process.env.EXTRA_ORIGIN] : []);
const clip = (v, n) => (typeof v === 'string' || typeof v === 'number') ? String(v).replace(/\s+/g, ' ').trim().slice(0, n) : '';
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 90;
}

function clean(e) {
  if (!e || !KINDS.includes(e.k)) return null;
  return {
    t: Date.now(), k: e.k, v: clip(e.v, 12), lid: clip(e.lid, 14).replace(/\D/g, ''), mls: clip(e.mls, 12).replace(/\D/g, ''),
    a: clip(e.a, 90), p: Number(String(e.p || '').replace(/[^\d]/g, '')) || 0, s: Math.min(Number(e.s) || 0, 3600), q: clip(e.q, 160),
  };
}

// Apply events to a browse list: "time" updates the seconds on the view it belongs to.
function apply(list, pid, events) {
  events.forEach((e) => {
    if (e.k === 'time') { const v = list.find((x) => x.k === 'view' && x.v && x.v === e.v && (!pid || x.pid === pid)); if (v) v.s = Math.max(v.s || 0, e.s); return; }
    if (pid) e.pid = pid;
    list.unshift(e);
  });
  if (list.length > MAX) list.length = MAX;
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  if (ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return res.status(429).json({ ok: false });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ ok: false });
  const events = (Array.isArray(body.events) ? body.events : []).slice(0, 12).map(clean).filter(Boolean);
  if (!events.length) return res.status(200).json({ ok: true });
  try {
    const b = body.board || {};
    if (store.validId(b.id) && typeof b.key === 'string') {
      const out = await store.update(b.id, (doc) => {
        const m = (doc.members || []).find((x) => x.key && x.key === b.key);
        if (!m) return 'forbidden';
        doc.browse = doc.browse || [];
        apply(doc.browse, m.pid, events);
        m.lastSeen = Date.now();
      });
      if (!out || out.result === 'forbidden') return res.status(403).json({ ok: false });
      return res.status(200).json({ ok: true });
    }
    const l = body.lead || {};
    if (lofty.leadTokenOk(l.id, l.t)) {
      await store.upsert('visitors', String(l.id), (doc) => { doc.browse = doc.browse || []; apply(doc.browse, '', events); doc.lastSeen = Date.now(); }, () => ({ leadId: Number(l.id) }));
      return res.status(200).json({ ok: true });
    }
    return res.status(403).json({ ok: false });
  } catch (e) {
    console.warn('track failed', e && e.message);
    return res.status(200).json({ ok: false });
  }
};
