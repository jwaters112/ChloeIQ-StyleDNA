// Browsing log from joshwaters.com for visitors who came in through StyleDNA.
// The Save button script sends what they view, search, heart and request. Board members are
// identified by their board key; quiz takers without a board by their signed Lofty lead link.
const store = require('./_lib/boards');
const lofty = require('./_lib/lofty');
const hot = require('./_lib/hot');

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

// Which of these events are worth telling Josh about right now.
function signals(list, pid, events, lastSeen, seen) {
  const out = [];
  const listingUrl = (e) => e.lid ? 'https://joshwaters.com/listing-detail/' + e.lid : '';
  const addr = (e) => (e.a || 'a home').split(',')[0];
  if (lastSeen && Date.now() - lastSeen > 14 * 86400000 && hot.fresh(seen, 'back')) out.push({ kind: 'back', what: 'is back browsing after ' + Math.round((Date.now() - lastSeen) / 86400000) + ' days away', link: '' });
  events.forEach((e) => {
    if ((e.k === 'tour' || e.k === 'contact') && hot.fresh(seen, e.k + '|' + (e.lid || e.a))) out.push({ kind: e.k, what: (e.k === 'tour' ? 'clicked to schedule a tour of ' : 'clicked contact on ') + addr(e), link: listingUrl(e) });
    if (e.k === 'view' && e.lid) {
      const n = list.filter((x) => x.k === 'view' && x.lid === e.lid && (!pid || x.pid === pid)).length;
      if (n >= 3 && hot.fresh(seen, 'repeat|' + e.lid)) out.push({ kind: 'repeat', what: `has viewed ${addr(e)} ${n} times`, link: listingUrl(e) });
    }
  });
  return out;
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
      let sig = [], who = null;
      const out = await store.update(b.id, (doc) => {
        const m = (doc.members || []).find((x) => x.key && x.key === b.key);
        if (!m) return 'forbidden';
        doc.browse = doc.browse || [];
        apply(doc.browse, m.pid, events);
        doc.hot = doc.hot || {};
        sig = signals(doc.browse, m.pid, events, m.lastSeen, doc.hot);
        sig.forEach((x) => { x.key = m.pid; });
        who = { name: m.name, leadId: m.leadId || null, board: doc.name };
        m.lastSeen = Date.now();
      });
      if (!out || out.result === 'forbidden') return res.status(403).json({ ok: false });
      for (const x of sig) {
        await hot.alert({ kind: x.kind, who: who.name, leadId: who.leadId, headline: `${who.name} ${x.what}`,
          details: [`Board: ${who.board}`], link: x.link || `https://homestyledna.com/board.html?id=${b.id}` });
      }
      return res.status(200).json({ ok: true });
    }
    const l = body.lead || {};
    if (lofty.leadTokenOk(l.id, l.t)) {
      let sig = [];
      const out = await store.upsert('visitors', String(l.id), (doc) => {
        doc.browse = doc.browse || [];
        apply(doc.browse, '', events);
        doc.hot = doc.hot || {};
        sig = signals(doc.browse, '', events, doc.lastSeen, doc.hot);
        doc.lastSeen = Date.now();
      }, () => ({ leadId: Number(l.id) }));
      if (sig.length) {
        let name = out.doc.name;
        if (!name) { const L = await lofty.lead(l.id); name = (L && L.name) || 'A StyleDNA lead'; await store.upsert('visitors', String(l.id), (doc) => { doc.name = name; }); }
        for (const x of sig) await hot.alert({ kind: x.kind, who: name, leadId: Number(l.id), headline: `${name} ${x.what}`, details: ['Took the StyleDNA quiz, no home board yet'], link: x.link });
      }
      return res.status(200).json({ ok: true });
    }
    return res.status(403).json({ ok: false });
  } catch (e) {
    console.warn('track failed', e && e.message);
    return res.status(200).json({ ok: false });
  }
};
