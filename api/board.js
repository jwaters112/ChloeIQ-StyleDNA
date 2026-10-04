// StyleDNA home boards: a private board a buyer shares with a partner or family by link.
// Members add homes, heart or pass them and comment; Josh's daily picks land here too.
// Each member has a public id (shown on reactions) and a private key (kept on their phone) that
// lets them act as themselves. Push alerts go to members who turned them on.

const store = require('./_lib/boards');
const mailer = require('./_lib/mailer');
const lofty = require('./_lib/lofty');
const leadFrom = (body) => { const l = body.lead || {}; return lofty.leadTokenOk(l.id, l.t) ? Number(l.id) : null; };

const MAX_MEMBERS = 8, MAX_HOMES = 150, MAX_COMMENTS = 60, MAX_EVENTS = 150;
const ARCHES = ['curator', 'sanctuary', 'architect', 'custodian', 'visionary', 'authenticist'];
const FETCH_HOSTS = ['joshwaters.com', 'www.joshwaters.com', 'www.realtor.com', 'realtor.com', 'www.zillow.com', 'zillow.com'];

const clip = (v, n) => (typeof v === 'string' || typeof v === 'number') ? String(v).replace(/\s+/g, ' ').trim().slice(0, n) : '';
const cleanName = (v) => clip(v, 24).replace(/[^A-Za-z0-9' .-]/g, '').trim();
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 60;
}

let webpush = null;
function push() {
  if (webpush) return webpush;
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return null;
  webpush = require('web-push');
  webpush.setVapidDetails('mailto:josh@dallascollectivegroup.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  return webpush;
}

// Send to every member with alerts on, except the one who did the thing. Dead subscriptions are dropped.
async function notify(board, exceptPid, title, body) {
  const wp = push();
  if (!wp || !board.subs || !board.subs.length) return [];
  const url = `/board.html?id=${board.id}`;
  const payload = JSON.stringify({ title, body, url, tag: 'board-' + board.id });
  const dead = [];
  await Promise.all(board.subs.filter((s) => s.pid !== exceptPid).map(async (s) => {
    try {
      await wp.sendNotification(s.sub, payload, { TTL: 86400 });
    } catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) dead.push(s.sub.endpoint);
      else console.warn('push failed', err && err.statusCode);
    }
  }));
  return dead;
}
// Email alerts for confirmed members; records when each was sent so add-home emails stay throttled.
async function emailAlert(board, exceptPid, opts) {
  try {
    const sent = await mailer.alertBoard(board, exceptPid, opts);
    if (sent.length) await store.update(board.id, (b) => { (b.emails || []).forEach((e) => { if (sent.includes(e.pid)) e.lastSent = Date.now(); }); });
  } catch (e) { console.warn('email alert failed', e && e.message); }
}
const commas = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const homeLine = (h) => {
  const facts = [h.beds ? h.beds + ' bd' : '', h.baths ? h.baths + ' ba' : '', h.sqft ? commas(h.sqft) + ' sqft' : ''].filter(Boolean).join(', ');
  return { url: h.url || '', address: h.address || 'Home', price: h.price ? '$' + commas(h.price) : '', why: [facts, h.note].filter(Boolean).join('. ') };
};

async function dropDead(id, dead) {
  if (!dead.length) return;
  await store.update(id, (b) => { b.subs = (b.subs || []).filter((s) => !dead.includes(s.sub.endpoint)); });
}

function event(b, kind, by, homeId, text) {
  b.events = b.events || [];
  b.events.unshift({ t: Date.now(), kind, by: by || '', homeId: homeId || '', text: clip(text, 140) });
  if (b.events.length > MAX_EVENTS) b.events.length = MAX_EVENTS;
}
const memberByKey = (b, key) => (b.members || []).find((m) => m.key && m.key === key);
const nameOf = (b, pid) => { const m = (b.members || []).find((x) => x.pid === pid); return m ? m.name : (pid === 'josh' ? 'Josh' : 'Someone'); };
const shortAddr = (h) => (h.address || 'a home').split(',')[0];

// What the page sees: no member keys, no push subscriptions.
function view(b) {
  return {
    id: b.id, name: b.name, createdAt: b.createdAt, criteria: b.criteria || {},
    members: (b.members || []).map((m) => ({ pid: m.pid, name: m.name, archetype: m.archetype || '', loves: m.loves || [], role: m.role || '' })),
    homes: b.homes || [], events: (b.events || []).slice(0, 60),
    alerts: (b.subs || []).map((s) => s.pid),
    emailOn: (b.emails || []).filter((e) => e.confirmed).map((e) => e.pid),
    emailPending: (b.emails || []).filter((e) => !e.confirmed).map((e) => e.pid),
  };
}

function money(v) { const n = String(v || '').replace(/[^\d.]/g, ''); return n ? Math.round(Number(n)) : 0; }

// Best effort: read address, price, beds, baths from the listing page's own preview tags.
// joshwaters.com answers servers with a bot check, so for its links we usually keep just the
// address from the link itself; the View link opens the full listing.
async function describeLink(url) {
  const out = { url, address: '', price: 0, beds: '', baths: '', sqft: '' };
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const slug = (u.pathname.match(/listing-detail\/\d+\/([^/?#]+)/) || [])[1];
  if (slug) out.address = decodeURIComponent(slug).replace(/-/g, ' ').replace(/\s+TX$/i, ', TX');
  if (!FETCH_HOSTS.includes(u.hostname)) return out;
  try {
    const r = await fetch(u.toString(), { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(6000), redirect: 'follow' });
    if (!r.ok) { console.warn('listing fetch', r.status, u.hostname); return out; }
    const html = (await r.text()).slice(0, 400000);
    const meta = (prop) => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)`, 'i')) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i')); return m ? m[1] : ''; };
    const title = meta('og:title') || (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
    const desc = meta('og:description') || meta('description') || '';
    const text = (title + ' | ' + desc).replace(/&amp;/g, '&').replace(/&#39;/g, "'");
    // joshwaters.com: "Homes for sale: 9105 Norman DR, Plano, TX 75025 (MLS #: 21398016) with 3 beds ..."
    const lofty = desc.match(/for sale:\s*([^(]+?)\s*\(MLS\s*#:\s*(\d+)\)/i);
    if (lofty) { out.address = lofty[1].trim(); out.mls = lofty[2]; }
    if (!out.address) out.address = clip(title.split('|')[0].split(' - ')[0], 90);
    const price = text.match(/\$\s?([\d,]{5,})/); if (price) out.price = money(price[1]);
    const beds = text.match(/(\d+)\s*(?:bd|beds?|bedrooms?)\b/i); if (beds) out.beds = beds[1];
    const baths = text.match(/(\d+(?:\.\d)?)\s*(?:ba|baths?|bathrooms?)\b/i); if (baths) out.baths = baths[1];
    const sqft = text.match(/([\d,]{3,})\s*(?:sq\.?\s?ft|sqft|square feet)/i); if (sqft) out.sqft = sqft[1].replace(/,/g, '');
  } catch (e) { console.warn('listing fetch failed', u.hostname, e && e.message); }
  out.address = clip(out.address, 90);
  return out;
}

function profileFrom(body) {
  const p = body.profile || {};
  return {
    archetype: ARCHES.includes(p.archetype) ? p.archetype : '',
    loves: Array.isArray(p.loves) ? p.loves.slice(0, 12).map((x) => clip(x, 40)).filter(Boolean) : [],
  };
}

module.exports = async function handler(req, res) {
  try {
    return await handle(req, res);
  } catch (err) {
    console.error('board error', err && err.message);
    return res.status(err && err.message === 'busy' ? 503 : 400).json({ ok: false, error: err && err.message === 'busy' ? 'busy' : 'bad_request' });
  }
};

// joshwaters.com listing pages save straight to the board (the Save button runs there).
const ALLOWED_ORIGINS = ['https://joshwaters.com', 'https://www.joshwaters.com'].concat(process.env.BOARD_STORE_DIR && process.env.EXTRA_ORIGIN ? [process.env.EXTRA_ORIGIN] : []);

async function handle(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return res.status(429).json({ ok: false, error: 'too_many' });

  if (req.method === 'GET') {
    if (req.query && req.query.vapid !== undefined) return res.status(200).json({ ok: true, key: process.env.VAPID_PUBLIC_KEY || '' });
    const id = req.query && req.query.id;
    const cur = await store.read(id);
    if (!cur) return res.status(404).json({ ok: false, error: 'not_found' });
    return res.status(200).json({ ok: true, board: view(cur.doc) });
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ ok: false }); }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ ok: false, error: 'bad_request' });
  const action = clip(body.action, 20);

  // ---- create a board (the person creating it is its first member) ----
  if (action === 'create') {
    const name = cleanName(body.name);
    if (!name) return res.status(400).json({ ok: false, error: 'name_required' });
    const prof = profileFrom(body);
    const c = body.criteria || {};
    const member = { pid: store.newId(8), key: store.newId(20), name, ...prof, joinedAt: Date.now() };
    const lid0 = leadFrom(body); if (lid0) member.leadId = lid0;
    const doc = {
      name: clip(body.boardName, 40) || `${name}'s home board`,
      createdAt: Date.now(),
      criteria: {
        archetype: prof.archetype, budget: Number.isInteger(c.budget) ? c.budget : null, budgetLabel: clip(c.budgetLabel, 30),
        homeType: clip(c.homeType, 30), homeTypeLabel: clip(c.homeTypeLabel, 30), area: clip(c.area, 60),
        areas: (Array.isArray(c.areas) ? c.areas : (c.area ? [c.area] : [])).slice(0, 6).map((a) => clip(a, 60)).filter(Boolean),
      },
      members: [member], homes: [], events: [], subs: [],
    };
    event(doc, 'join', member.pid, '', `${name} started the board`);
    const saved = await store.create(doc);
    return res.status(200).json({ ok: true, id: saved.id, pid: member.pid, key: member.key, board: view(saved) });
  }

  if (action === 'admin-delete') {
    if (process.env.VERCEL_ENV !== 'preview' && !process.env.BOARD_STORE_DIR) return res.status(404).json({ ok: false });
    const ok = await store.remove(body.id);
    return res.status(200).json({ ok });
  }
  if (action === 'admin-list') {
    if (process.env.VERCEL_ENV !== 'preview' && !process.env.BOARD_STORE_DIR) return res.status(404).json({ ok: false });
    const ids = await store.listIds();
    const boards = [];
    for (const bid of ids) {
      const cur = await store.read(bid);
      if (!cur) continue;
      const b = cur.doc;
      boards.push({ id: b.id, name: b.name, criteria: b.criteria, members: (b.members || []).map((m) => ({ name: m.name, archetype: m.archetype })),
        mls: (b.homes || []).map((h) => h.mls).filter(Boolean), alerts: (b.subs || []).length, updatedAt: b.updatedAt || b.createdAt,
        activity: (b.events || []).slice(0, 15).map((e) => ({ t: e.t, text: e.text })) });
    }
    return res.status(200).json({ ok: true, boards });
  }

  const id = body.id;
  if (!store.validId(id)) return res.status(400).json({ ok: false, error: 'bad_board' });

  // ---- join ----
  if (action === 'join') {
    const name = cleanName(body.name);
    if (!name) return res.status(400).json({ ok: false, error: 'name_required' });
    const prof = profileFrom(body);
    let member = null;
    const out = await store.update(id, (b) => {
      if ((b.members || []).length >= MAX_MEMBERS) return 'full';
      member = { pid: store.newId(8), key: store.newId(20), name, ...prof, joinedAt: Date.now() };
      const lid1 = leadFrom(body); if (lid1) member.leadId = lid1;
      b.members.push(member);
      event(b, 'join', member.pid, '', `${name} joined`);
    });
    if (!out) return res.status(404).json({ ok: false, error: 'not_found' });
    if (out.result === 'full') return res.status(409).json({ ok: false, error: 'full' });
    const dead = await notify(out.doc, member.pid, out.doc.name, `${name} joined your home board`);
    await dropDead(id, dead);
    return res.status(200).json({ ok: true, pid: member.pid, key: member.key, board: view(out.doc) });
  }

  // ---- admin: daily picks from the morning run. Preview site only (behind Josh's Vercel sign-in). ----
  if (action === 'admin-picks') {
    if (process.env.VERCEL_ENV !== 'preview' && !process.env.BOARD_STORE_DIR) return res.status(404).json({ ok: false });
    const picks = (Array.isArray(body.homes) ? body.homes : []).slice(0, 10);
    let added = [];
    const out = await store.update(id, (b) => {
      const have = new Set((b.homes || []).map((h) => h.mls).filter(Boolean));
      added = [];
      picks.forEach((p) => {
        const mls = clip(p.mls, 12);
        if (!mls || have.has(mls) || b.homes.length >= MAX_HOMES) return;
        const h = {
          id: store.newId(8), source: 'josh', mls, url: clip(p.url, 500), address: clip(p.address, 90), city: clip(p.city, 40),
          price: money(p.price), beds: clip(p.beds, 4), baths: clip(p.baths, 5), sqft: clip(p.sqft, 7), style: clip(p.style, 30),
          note: clip(p.note, 200), isNew: !!p.isNew, photo: /^https:\/\//.test(p.photo || '') ? clip(p.photo, 600) : '', status: clip(p.status, 30) || 'Active', listPrice: money(p.price),
          addedBy: 'josh', addedAt: Date.now(), reactions: {}, comments: [],
        };
        b.homes.unshift(h); added.push(h); have.add(mls);
      });
      if (!added.length) return false;
      event(b, 'picks', 'josh', added[0].id, `Josh added ${added.length} new ${added.length === 1 ? 'home that fits' : 'homes that fit'} your StyleDNA`);
    });
    if (!out) return res.status(404).json({ ok: false, error: 'not_found' });
    if (added.length) {
      const first = added[0];
      const bits = [first.city, first.price ? '$' + first.price.toLocaleString('en-US') : '', first.beds ? first.beds + ' bd' : ''].filter(Boolean).join(', ');
      const dead = await notify(out.doc, 'josh', added.length === 1 ? 'New listing fits your StyleDNA' : `${added.length} new listings fit your StyleDNA`, `${shortAddr(first)}${bits ? ' (' + bits + ')' : ''}. Tap to see it on your board.`);
      await dropDead(id, dead);
      await emailAlert(out.doc, 'josh', { kind: 'picks', homes: added.map(homeLine) });
    }
    return res.status(200).json({ ok: true, added: added.length });
  }
  // ---- everything below acts as a member ----
  const key = clip(body.key, 40);
  let actor = null;

  if (action === 'add-home') {
    const link = clip(body.url, 500);
    const typed = clip(body.address, 90);
    if (!link && !typed) return res.status(400).json({ ok: false, error: 'missing' });
    // From the Save button: the listing page already told us the details, so don't fetch it.
    const d = body.details && typeof body.details === 'object' ? body.details : null;
    let info;
    if (link && d && /^https:\/\/(www\.)?joshwaters\.com\/listing-detail\//.test(link)) {
      info = { url: link.split('#')[0].split('?')[0], address: clip(d.address, 90), mls: clip(d.mls, 12).replace(/\D/g, ''),
        price: money(d.price), beds: clip(d.beds, 4), baths: clip(d.baths, 5), sqft: clip(d.sqft, 7).replace(/\D/g, '') };
    } else {
      info = link ? await describeLink(link) : { url: '', address: typed };
    }
    if (!info) return res.status(400).json({ ok: false, error: 'bad_link' });
    // joshwaters.com links carry Lofty's listing id: fill in status, photo and any missing facts from Lofty.
    const lidM = (info.url || '').match(/joshwaters\.com\/listing-detail\/(\d+)/);
    if (lidM) {
      const L = await lofty.listingById(lidM[1]);
      if (L) {
        info.address = info.address || L.address; info.mls = info.mls || L.mls; info.price = info.price || L.price;
        info.beds = info.beds || L.beds; info.baths = info.baths || L.baths; info.sqft = info.sqft || L.sqft;
        info.photo = L.photo; info.status = L.status; info.city = L.city; info.openHouse = L.openHouse;
      }
    }
    if (!info.address) info.address = typed || 'Home';
    const via = body.via === 'heart' ? 'heart' : (body.via === 'save' ? 'save' : '');
    let home = null, dupId = '';
    const out = await store.update(id, (b) => {
      actor = memberByKey(b, key);
      if (!actor) return 'forbidden';
      if (b.homes.length >= MAX_HOMES) return 'full';
      const same = info.url && b.homes.find((h) => h.url === info.url || (info.mls && h.mls === info.mls));
      if (same) { dupId = same.id; return 'dupe'; }
      home = { id: store.newId(8), source: 'member', mls: info.mls || '', url: info.url || '', address: info.address, price: info.price || 0, beds: info.beds || '', baths: info.baths || '', sqft: info.sqft || '',
        city: info.city || '', photo: info.photo || '', status: info.status || '', listPrice: info.price || 0, openHouse: info.openHouse || null,
        addedBy: actor.pid, addedAt: Date.now(), reactions: { [actor.pid]: 'love' }, comments: [] };
      if (via) home.via = via;
      const note = clip(body.note, 300);
      if (note) home.comments.push({ id: store.newId(6), by: actor.pid, text: note, at: Date.now() });
      b.homes.unshift(home);
      event(b, 'add', actor.pid, home.id, via === 'heart' ? `${actor.name} loved ${shortAddr(home)} on joshwaters.com` : `${actor.name} added ${shortAddr(home)}`);
    });
    if (!out) return res.status(404).json({ ok: false, error: 'not_found' });
    if (out.result === 'forbidden') return res.status(403).json({ ok: false, error: 'not_member' });
    if (out.result === 'dupe') return res.status(409).json({ ok: false, error: 'already_added', homeId: dupId, boardName: out.doc.name });
    if (out.result === 'full') return res.status(409).json({ ok: false, error: 'full' });
    const dead = await notify(out.doc, actor.pid, out.doc.name, `${actor.name} added ${shortAddr(home)}`);
    await dropDead(id, dead);
    await emailAlert(out.doc, actor.pid, { kind: 'add', homes: [homeLine(home)], reason: `${actor.name} added a home to the board.` });
    return res.status(200).json({ ok: true, homeId: home.id, board: view(out.doc) });
  }

  if (action === 'react') {
    const value = ['love', 'pass', ''].includes(body.value) ? body.value : null;
    if (value === null) return res.status(400).json({ ok: false });
    let matched = null;
    const out = await store.update(id, (b) => {
      actor = memberByKey(b, key);
      if (!actor) return 'forbidden';
      const h = b.homes.find((x) => x.id === body.homeId);
      if (!h) return 'missing';
      const before = h.reactions[actor.pid] || '';
      if (before === value) return false;
      if (value) h.reactions[actor.pid] = value; else delete h.reactions[actor.pid];
      const people = b.members.filter((m) => m.role !== 'agent');
      const allLove = people.length >= 2 && people.every((m) => h.reactions[m.pid] === 'love');
      if (allLove && !h.match) { h.match = Date.now(); matched = h; event(b, 'match', actor.pid, h.id, `Group match: everyone loves ${shortAddr(h)}`); }
      else if (!allLove && h.match) delete h.match;
      if (value === 'love' && !matched) event(b, 'love', actor.pid, h.id, `${actor.name} loves ${shortAddr(h)}`);
      if (value === 'pass') event(b, 'pass', actor.pid, h.id, `${actor.name} passed on ${shortAddr(h)}`);
    });
    if (!out) return res.status(404).json({ ok: false, error: 'not_found' });
    if (out.result === 'forbidden') return res.status(403).json({ ok: false, error: 'not_member' });
    if (out.result === 'missing') return res.status(404).json({ ok: false, error: 'no_home' });
    if (matched) {
      const dead = await notify(out.doc, null, 'Group match', `Everyone loves ${shortAddr(matched)}. Time to see it in person?`);
      await dropDead(id, dead);
      await emailAlert(out.doc, null, { kind: 'match', homes: [homeLine(matched)], reason: 'Everyone on the board loves this one. Time to see it in person?' });
    }
    return res.status(200).json({ ok: true, board: view(out.doc) });
  }

  if (action === 'comment') {
    const text = clip(body.text, 300);
    if (!text) return res.status(400).json({ ok: false, error: 'empty' });
    let home = null;
    const out = await store.update(id, (b) => {
      actor = memberByKey(b, key);
      if (!actor) return 'forbidden';
      home = b.homes.find((x) => x.id === body.homeId);
      if (!home) return 'missing';
      if (home.comments.length >= MAX_COMMENTS) home.comments.shift();
      home.comments.push({ id: store.newId(6), by: actor.pid, text, at: Date.now() });
      event(b, 'comment', actor.pid, home.id, `${actor.name} on ${shortAddr(home)}: ${text}`);
    });
    if (!out) return res.status(404).json({ ok: false, error: 'not_found' });
    if (out.result === 'forbidden') return res.status(403).json({ ok: false, error: 'not_member' });
    if (out.result === 'missing') return res.status(404).json({ ok: false, error: 'no_home' });
    const dead = await notify(out.doc, actor.pid, `${actor.name} commented`, `${shortAddr(home)}: ${text.slice(0, 90)}`);
    await dropDead(id, dead);
    return res.status(200).json({ ok: true, board: view(out.doc) });
  }

  if (action === 'remove-home') {
    const out = await store.update(id, (b) => {
      actor = memberByKey(b, key);
      if (!actor) return 'forbidden';
      const i = b.homes.findIndex((x) => x.id === body.homeId && x.addedBy === actor.pid);
      if (i < 0) return 'missing';
      b.homes.splice(i, 1);
    });
    if (!out) return res.status(404).json({ ok: false, error: 'not_found' });
    if (out.result === 'forbidden') return res.status(403).json({ ok: false, error: 'not_member' });
    if (out.result === 'missing') return res.status(404).json({ ok: false, error: 'no_home' });
    return res.status(200).json({ ok: true, board: view(out.doc) });
  }

  if (action === 'subscribe' || action === 'unsubscribe') {
    const sub = body.subscription;
    const endpoint = sub && typeof sub.endpoint === 'string' ? sub.endpoint : '';
    if (action === 'subscribe' && (!/^https:\/\//.test(endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth)) return res.status(400).json({ ok: false, error: 'bad_subscription' });
    const out = await store.update(id, (b) => {
      actor = memberByKey(b, key);
      if (!actor) return 'forbidden';
      b.subs = (b.subs || []).filter((s) => s.sub.endpoint !== endpoint && !(action === 'unsubscribe' && s.pid === actor.pid));
      if (action === 'subscribe') b.subs.push({ pid: actor.pid, sub: { endpoint, keys: { p256dh: clip(sub.keys.p256dh, 200), auth: clip(sub.keys.auth, 60) } }, at: Date.now() });
      if (b.subs.length > 40) b.subs = b.subs.slice(-40);
    });
    if (!out) return res.status(404).json({ ok: false, error: 'not_found' });
    if (out.result === 'forbidden') return res.status(403).json({ ok: false, error: 'not_member' });
    return res.status(200).json({ ok: true, board: view(out.doc) });
  }

  if (action === 'link-lead') {
    const lid = leadFrom(body);
    if (!lid) return res.status(400).json({ ok: false, error: 'bad_lead' });
    const out = await store.update(id, (b) => {
      actor = memberByKey(b, key);
      if (!actor) return 'forbidden';
      if (actor.leadId === lid) return false;
      actor.leadId = lid;
    });
    if (!out) return res.status(404).json({ ok: false, error: 'not_found' });
    if (out.result === 'forbidden') return res.status(403).json({ ok: false, error: 'not_member' });
    return res.status(200).json({ ok: true });
  }

  if (action === 'email-on' || action === 'email-off') {
    const email = action === 'email-on' ? mailer.cleanEmail(body.email) : '';
    if (action === 'email-on' && !email) return res.status(400).json({ ok: false, error: 'bad_email' });
    let entry = null, resend = false;
    const out = await store.update(id, (b) => {
      actor = memberByKey(b, key);
      if (!actor) return 'forbidden';
      b.emails = b.emails || [];
      const mine = b.emails.find((e) => e.pid === actor.pid);
      if (action === 'email-off') { b.emails = b.emails.filter((e) => e.pid !== actor.pid); return; }
      if (mine && mine.email === email && (mine.confirmed || Date.now() - (mine.sentAt || 0) < 10 * 60 * 1000)) { entry = mine; return false; }
      b.emails = b.emails.filter((e) => e.pid !== actor.pid);
      entry = { pid: actor.pid, email, token: store.newId(20), confirmed: false, at: Date.now(), sentAt: Date.now() };
      b.emails.push(entry); resend = true;
      if (b.emails.length > 40) b.emails = b.emails.slice(-40);
    });
    if (!out) return res.status(404).json({ ok: false, error: 'not_found' });
    if (out.result === 'forbidden') return res.status(403).json({ ok: false, error: 'not_member' });
    if (resend) {
      const r = await mailer.sendConfirm(out.doc, entry, actor);
      if (!r.ok) return res.status(502).json({ ok: false, error: 'send_failed', board: view(out.doc) });
    }
    return res.status(200).json({ ok: true, state: action === 'email-off' ? 'off' : (entry && entry.confirmed ? 'on' : 'pending'), board: view(out.doc) });
  }

  return res.status(400).json({ ok: false, error: 'unknown_action' });
}
