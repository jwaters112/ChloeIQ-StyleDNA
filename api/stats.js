// StyleDNA's own analytics. POST: anonymous events from the quiz (visit, quiz start and finish with
// the styles they loved and passed, lead, board, share, home value). One small document per day.
// GET (with Josh's key): everything the scoreboard page shows.
const store = require('./_lib/boards');

const TYPES = ['visit', 'quiz_start', 'quiz_done', 'lead', 'board', 'share', 'value'];
const clip = (v, n) => (typeof v === 'string' || typeof v === 'number') ? String(v).replace(/\s+/g, ' ').trim().slice(0, n) : '';
const dayKey = (t) => 'd' + new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }).replace(/-/g, '');
const bump = (obj, k, n) => { if (!k) return; obj[k] = (obj[k] || 0) + (n || 1); };
const hits = new Map();
const trendMem = { at: 0, counts: {} };
const now0 = () => Date.now();

function addEvent(doc, e) {
  doc.c = doc.c || {}; doc.src = doc.src || {}; doc.ref = doc.ref || {}; doc.uniq = doc.uniq || [];
  bump(doc.c, e.type);
  if (e.type === 'visit') {
    if (e.sid && !doc.uniq.includes(e.sid)) { if (doc.uniq.length < 5000) doc.uniq.push(e.sid); bump(doc.c, e.isNew ? 'new' : 'returning'); }
    bump(doc.src, e.channel || 'Direct');
    if (e.r) bump(doc.ref, e.r);
  }
  if (e.type === 'quiz_done') {
    ['arch', 'loved', 'passed', 'area', 'budget', 'htype'].forEach((k) => { doc[k] = doc[k] || {}; });
    bump(doc.arch, e.archetype);
    (e.loved || []).forEach((x) => bump(doc.loved, x));
    (e.passed || []).forEach((x) => bump(doc.passed, x));
    (e.areas || []).forEach((x) => bump(doc.area, x));
    bump(doc.budget, e.budget); bump(doc.htype, e.homeType || 'Any');
    doc.musts = doc.musts || {}; (e.musts || []).forEach((x) => bump(doc.musts, x));
    // How people decide: from the curb or once inside, and which rooms win them over or turn them off.
    ['decide', 'wins', 'bails'].forEach((k) => { doc[k] = doc[k] || {}; });
    bump(doc.decide, e.decide); (e.wins || []).forEach((x) => bump(doc.wins, x)); (e.bails || []).forEach((x) => bump(doc.bails, x));
  }
  if (e.type === 'share') { doc.shareCh = doc.shareCh || {}; bump(doc.shareCh, e.channel || 'native'); }
}

function merge(into, doc) {
  ['c', 'src', 'ref', 'arch', 'loved', 'passed', 'area', 'budget', 'htype', 'shareCh', 'musts', 'decide', 'wins', 'bails'].forEach((k) => {
    into[k] = into[k] || {}; Object.entries(doc[k] || {}).forEach(([x, n]) => bump(into[k], x, n));
  });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'POST') {
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < 60000); list.push(now); hits.set(ip, list);
    if (hits.size > 5000) hits.clear();
    if (list.length > 40) return res.status(429).end();
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
    if (!b || !TYPES.includes(b.type)) return res.status(204).end();
    const ua = String(req.headers['user-agent'] || '');
    if (/bot|crawl|spider|preview|facebookexternalhit|slurp|headless/i.test(ua)) return res.status(204).end();
    const e = {
      type: b.type, sid: clip(b.sid, 16).replace(/[^A-Za-z0-9]/g, ''), isNew: !!b.isNew, channel: clip(b.channel, 40), r: clip(b.r, 16).replace(/[^A-Za-z0-9]/g, ''),
      archetype: clip(b.archetype, 20), budget: clip(b.budget, 30), homeType: clip(b.homeType, 30),
      loved: (Array.isArray(b.loved) ? b.loved : []).slice(0, 12).map((x) => clip(x, 40)), passed: (Array.isArray(b.passed) ? b.passed : []).slice(0, 12).map((x) => clip(x, 40)),
      areas: (Array.isArray(b.areas) ? b.areas : []).slice(0, 6).map((x) => clip(x, 60)),
      musts: (Array.isArray(b.musts) ? b.musts : []).slice(0, 12).map((x) => clip(x, 20).replace(/[^a-z0-9]/g, '')).filter(Boolean),
      decide: ['curb', 'inside', 'mixed'].includes(b.decide) ? b.decide : '',
      wins: (Array.isArray(b.wins) ? b.wins : []).slice(0, 4).map((x) => clip(x, 20).replace(/[^a-z_]/g, '')).filter(Boolean),
      bails: (Array.isArray(b.bails) ? b.bails : []).slice(0, 4).map((x) => clip(x, 20).replace(/[^a-z_]/g, '')).filter(Boolean),
    };
    try { await store.upsert('stats', dayKey(now), (doc) => addEvent(doc, e)); } catch (err) { console.warn('stats write failed', err && err.message); }
    return res.status(204).end();
  }

  // ---- public: which must-haves people pick most (last 30 days), so the quiz shows the top ones first ----
  if (req.query && req.query.trend === 'musts') {
    if (!trendMem.at || now0() - trendMem.at > 3600000) {
      const counts = {};
      for (let i = 0; i < 30; i++) { const cur = await store.readIn('stats', dayKey(Date.now() - i * 86400000)).catch(() => null); Object.entries((cur && cur.doc && cur.doc.musts) || {}).forEach(([k, n]) => bump(counts, k, n)); }
      trendMem.at = now0(); trendMem.counts = counts;
    }
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).json({ ok: true, musts: trendMem.counts });
  }
  // ---- scoreboard data (Josh only) ----
  const key = process.env.STATS_KEY;
  if (!key || (req.query && req.query.k) !== key) return res.status(401).json({ ok: false });
  const days = Math.min(Number((req.query && req.query.days) || 30), 90);
  const now = Date.now();
  const series = [], total = {}, last7 = {}, prev7 = {};
  for (let i = days - 1; i >= 0; i--) {
    const t = now - i * 86400000;
    const cur = await store.readIn('stats', dayKey(t));
    const d = cur ? cur.doc : {};
    const c = d.c || {};
    series.push({ day: new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }), visitors: (d.uniq || []).length, newVisitors: c.new || 0,
      quizStarts: c.quiz_start || 0, quizDone: c.quiz_done || 0, leads: c.lead || 0, boards: c.board || 0, shares: c.share || 0, values: c.value || 0 });
    merge(total, d);
    if (i < 7) merge(last7, d); else if (i < 14) merge(prev7, d);
  }
  // Names for top sharers who later became leads.
  const refs = Object.entries(total.ref || {}).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const sharers = [];
  for (const [sid, n] of refs) { const s = await store.readIn('sharers', sid); sharers.push({ name: (s && s.doc.name) || 'Someone not yet in Lofty', visits: n, leadId: s && s.doc.leadId }); }
  const latest = await store.readIn('stats', 'latest00');
  return res.status(200).json({ ok: true, series, total, last7, prev7, sharers, report: latest ? latest.doc.report : null });
};
