// Morning (and early evening) job, run by Vercel's scheduler.
// 1. Checks every saved home on every board against Lofty: price drops, under contract, sold,
//    back on the market, off the market, new open houses. Updates the board and alerts members.
// 2. Mornings only: writes one Lofty note per lead summarizing their StyleDNA and joshwaters.com activity.
const store = require('./_lib/boards');
const lofty = require('./_lib/lofty');
const mailer = require('./_lib/mailer');

const money = (n) => '$' + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const short = (a) => String(a || 'a home').split(',')[0];
const DAY = 86400000;
const OFF = (s) => /off market|sold/i.test(s || '');
const todayCT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const upcoming = (start) => String(start || '').slice(0, 10) >= todayCT();

let webpush = null;
function push() {
  if (webpush) return webpush;
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return null;
  webpush = require('web-push');
  webpush.setVapidDetails('mailto:josh@dallascollectivegroup.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  return webpush;
}
async function notifyAll(board, title, body) {
  const wp = push();
  if (!wp || !(board.subs || []).length) return [];
  const payload = JSON.stringify({ title, body, url: `/board.html?id=${board.id}`, tag: 'board-' + board.id });
  const dead = [];
  await Promise.all(board.subs.map(async (s) => {
    try { await wp.sendNotification(s.sub, payload, { TTL: 86400 }); }
    catch (err) { if (err && (err.statusCode === 404 || err.statusCode === 410)) dead.push(s.sub.endpoint); }
  }));
  return dead;
}

function bucket(status) {
  const s = String(status || '');
  if (/sold|closed/i.test(s)) return 'Sold';
  if (/under contract|pending|option|contingen|kick ?out/i.test(s)) return 'Under contract';
  if (/coming soon/i.test(s)) return 'Coming soon';
  if (/active/i.test(s)) return 'Active';
  return s || 'Active';
}

// Compare one home with Lofty's current listing. Returns a change line or null; updates the home.
function compare(h, L, lookupOk, now) {
  const prevStatus = bucket(h.status), prevPrice = Number(h.price) || 0;
  let change = null;
  if (L) {
    h.misses = 0;
    if (!h.photo && L.photo) h.photo = L.photo;
    if (!h.city && L.city) h.city = L.city;
    const st = bucket(L.status);
    if (st !== prevStatus) {
      if (st === 'Under contract') change = { kind: 'contract', label: 'Under contract', text: `${short(h.address)} is now under contract.` };
      else if (st === 'Sold') change = { kind: 'sold', label: 'Sold', text: `${short(h.address)} sold${L.price ? ' for ' + money(L.price) : ''}.` };
      else if (st === 'Active' && (prevStatus === 'Under contract' || OFF(prevStatus))) change = { kind: 'back', label: 'Back on the market', text: `${short(h.address)} is back on the market${L.price ? ' at ' + money(L.price) : ''}.` };
      h.status = st;
    }
    if (!change && L.price && prevPrice && L.price < prevPrice && st !== 'Sold') {
      const drop = prevPrice - L.price;
      change = { kind: 'drop', label: `Price drop ${money(drop)}`, text: `${short(h.address)} dropped ${money(drop)} to ${money(L.price)}.` };
    }
    if (L.price && st !== 'Sold') h.price = L.price;
    if (L.openHouse && L.openHouse.start && L.openHouse.start !== (h.openHouse && h.openHouse.start) && upcoming(L.openHouse.start)) {
      h.openHouse = L.openHouse;
      if (!change) change = { kind: 'open', label: 'Open house', text: `Open house at ${short(h.address)}: ${L.openHouse.text}.` };
    }
  } else if (lookupOk && h.mls && !OFF(h.status)) {
    // Not in Lofty's feed twice in a row: expired, cancelled or withdrawn.
    h.misses = (h.misses || 0) + 1;
    if (h.misses >= 2) {
      h.status = 'Off market';
      change = { kind: 'off', label: 'Off the market', text: `${short(h.address)} came off the market (expired, cancelled or withdrawn).` };
    }
  }
  if (change) {
    h.changes = h.changes || [];
    h.changes.unshift({ t: now, kind: change.kind, text: change.text });
    if (h.changes.length > 12) h.changes.length = 12;
    h.lastChange = { t: now, kind: change.kind, label: change.label };
  }
  return change;
}

async function checkListings(report, only) {
  const ids = only ? [only] : await store.listIds();
  const boards = [];
  for (const id of ids) { const cur = await store.read(id); if (cur) boards.push(cur.doc); }
  const all = [];
  boards.forEach((b) => (b.homes || []).forEach((h) => { if (h.mls && !/sold/i.test(h.status || '')) all.push(h.mls); }));
  const map = await lofty.listingsByMls(all);
  const ok = !!map.__ok;
  report.lookups = all.length; report.found = Object.keys(map).length; report.lookupOk = ok;
  const now = Date.now();
  for (const b0 of boards) {
    let changes = [];
    const out = await store.update(b0.id, (b) => {
      changes = [];
      (b.homes || []).forEach((h) => {
        if (!h.mls || /sold/i.test(h.status || '')) return;
        const c = compare(h, map[h.mls], ok, now);
        if (c) changes.push({ h, c });
      });
      if (!changes.length) return false;
      b.events = b.events || [];
      changes.forEach(({ h, c }) => b.events.unshift({ t: now, kind: 'update', by: 'josh', homeId: h.id, text: c.text }));
      if (b.events.length > 150) b.events.length = 150;
    });
    if (!out || !changes.length) continue;
    report.changes.push(...changes.map(({ c }) => c.text));
    const first = changes[0].c;
    const dead = await notifyAll(out.doc, changes.length === 1 ? first.label : `${changes.length} updates on your saved homes`, changes.length === 1 ? first.text : changes.map(({ c }) => c.text).join(' '));
    if (dead.length) await store.update(b0.id, (b) => { b.subs = (b.subs || []).filter((s) => !dead.includes(s.sub.endpoint)); });
    const homes = changes.map(({ h, c }) => ({ url: h.url || '', address: h.address, change: c.label, price: h.price ? money(h.price) : '', why: c.text }));
    try {
      const sent = await mailer.alertBoard(out.doc, null, { kind: 'update', homes, reason: changes.length === 1 ? 'News on a home you saved.' : 'News on homes you saved.',
        subject: changes.length === 1 ? `${first.label}: ${short(changes[0].h.address)}` : `${changes.length} updates on homes you saved` });
      if (sent.length) await store.update(b0.id, (b) => { (b.emails || []).forEach((e) => { if (sent.includes(e.pid)) e.lastSent = Date.now(); }); });
    } catch (e) { console.warn('update email failed', e && e.message); }
  }
}

// ---- one Lofty note per lead with new activity ----
function summarize(browse, events, since) {
  const fresh = (browse || []).filter((e) => e.t > since);
  const views = fresh.filter((e) => e.k === 'view');
  const lines = [];
  if (views.length) {
    const byListing = {};
    views.forEach((v) => { const k = v.lid || v.a; const x = byListing[k] || (byListing[k] = { a: v.a, p: v.p, s: 0, n: 0 }); x.s += v.s || 0; x.n++; });
    const top = Object.values(byListing).sort((a, b) => b.s - a.s || b.n - a.n).slice(0, 8)
      .map((x) => `${short(x.a)}${x.p ? ' (' + money(x.p) + ')' : ''}${x.s >= 60 ? ', ' + Math.round(x.s / 60) + ' min' : x.s ? ', ' + x.s + ' sec' : ''}${x.n > 1 ? ', ' + x.n + ' visits' : ''}`);
    lines.push(`Viewed ${Object.keys(byListing).length} listing${Object.keys(byListing).length === 1 ? '' : 's'} on joshwaters.com: ${top.join('; ')}`);
  }
  const searches = [...new Set(fresh.filter((e) => e.k === 'search').map((e) => e.q).filter(Boolean))].slice(0, 5);
  if (searches.length) lines.push(`Searched: ${searches.join(' / ')}`);
  const list = (k, label) => { const xs = [...new Set(fresh.filter((e) => e.k === k).map((e) => short(e.a)).filter(Boolean))]; if (xs.length) lines.push(`${label}: ${xs.join(', ')}`); };
  list('heart', 'Hearted on joshwaters.com');
  list('save', 'Saved to home board');
  list('tour', 'Clicked to schedule a tour');
  list('contact', 'Clicked contact');
  const ev = (events || []).filter((e) => e.t > since);
  const count = (kind) => ev.filter((e) => e.kind === kind).length;
  const bits = [count('love') && `${count('love')} heart${count('love') === 1 ? '' : 's'}`, count('pass') && `${count('pass')} pass${count('pass') === 1 ? '' : 'es'}`, count('comment') && `${count('comment')} comment${count('comment') === 1 ? '' : 's'}`, count('add') && `${count('add')} home${count('add') === 1 ? '' : 's'} added`].filter(Boolean);
  if (bits.length) lines.push(`On their board: ${bits.join(', ')}`);
  ev.filter((e) => e.kind === 'comment').slice(0, 3).forEach((e) => lines.push(`Comment: ${e.text}`));
  return lines;
}

async function writeNotes(report, only, onlyVisitor) {
  const now = Date.now();
  const date = new Date(now).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric' });
  for (const id of (only ? [only] : (onlyVisitor ? [] : await store.listIds()))) {
    const cur = await store.read(id);
    if (!cur) continue;
    const b = cur.doc;
    const done = [];
    for (const m of (b.members || [])) {
      if (!m.leadId) continue;
      const since = Math.max(m.notedAt || 0, now - 3 * DAY);
      const lines = summarize((b.browse || []).filter((e) => e.pid === m.pid), (b.events || []).filter((e) => e.by === m.pid), since);
      if (!lines.length) continue;
      const ok = await lofty.addNote(m.leadId, [`StyleDNA activity, ${date} (${b.name}):`, ...lines.map((l) => '- ' + l), `Board: https://homestyledna.com/board.html?id=${b.id}`].join('\n'));
      if (ok) { done.push(m.pid); report.notes++; }
    }
    if (done.length) await store.update(id, (doc) => { (doc.members || []).forEach((m) => { if (done.includes(m.pid)) m.notedAt = now; }); });
  }
  for (const vid of (onlyVisitor ? [onlyVisitor] : (only ? [] : await store.listSpace('visitors')))) {
    const cur = await store.readIn('visitors', vid);
    if (!cur || !cur.doc.leadId) continue;
    const since = Math.max(cur.doc.notedAt || 0, now - 3 * DAY);
    const lines = summarize(cur.doc.browse, [], since);
    if (!lines.length) continue;
    const ok = await lofty.addNote(cur.doc.leadId, [`StyleDNA activity, ${date}:`, ...lines.map((l) => '- ' + l)].join('\n'));
    if (ok) { report.notes++; await store.upsert('visitors', vid, (doc) => { doc.notedAt = now; }); }
  }
}

module.exports = async (req, res) => {
  // Live site: only Vercel's scheduler may run this. Test site: Josh's signed-in browser.
  if (process.env.VERCEL_ENV === 'production') {
    const want = process.env.CRON_SECRET ? 'Bearer ' + process.env.CRON_SECRET : null;
    if (!want || req.headers.authorization !== want) return res.status(401).json({ ok: false });
  } else if (process.env.VERCEL_ENV !== 'preview' && !process.env.BOARD_STORE_DIR) {
    return res.status(404).json({ ok: false });
  }
  const q = req.query || {};
  const part = q.part || 'all';
  // Test runs on the test site can be limited to one board or one visitor.
  const only = process.env.VERCEL_ENV === 'production' ? null : (q.board || null);
  const onlyVisitor = process.env.VERCEL_ENV === 'production' ? null : (q.visitor || null);
  const report = { part, changes: [], notes: 0 };
  try {
    if (part === 'all' || part === 'listings') await checkListings(report, only);
    if (part === 'all' || part === 'notes') await writeNotes(report, only, onlyVisitor);
  } catch (e) {
    console.error('daily job failed', e && e.message);
    report.error = String(e && e.message);
  }
  console.log('daily job', JSON.stringify(report).slice(0, 2000));
  return res.status(200).json(report);
};
