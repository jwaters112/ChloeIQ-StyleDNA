// Morning (and early evening) job, run by Vercel's scheduler.
// 1. Checks every saved home on every board against Lofty: price drops, under contract, sold,
//    back on the market, off the market, new open houses. Updates the board and alerts members.
// 2. Mornings only: writes one Lofty note per lead summarizing their StyleDNA and joshwaters.com activity.
const store = require('./_lib/boards');
const poolLib = require('./_lib/pool');
const lofty = require('./_lib/lofty');
const mailer = require('./_lib/mailer');
const hotLib = require('./_lib/hot');

const money = (n) => '$' + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const short = (a) => String(a || 'a home').split(',')[0];
const DAY = 86400000;
const OFF = (s) => /off market|sold/i.test(s || '');
const todayCT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const ctTime = (str) => { const m = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', timeZoneName: 'shortOffset' }).match(/GMT([+-]\d+)/); const h = m ? Number(m[1]) : -6; return Date.parse(String(str || '').replace(' ', 'T') + (h < 0 ? '-' : '+') + String(Math.abs(h)).padStart(2, '0') + ':00') || 0; };
const upcoming = (start) => ctTime(start) > Date.now();

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
    if (L.office) h.office = L.office;
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
    const homes = changes.map(({ h, c }) => ({ url: h.url || '', address: h.address, office: h.office || '', change: c.label, price: h.price ? money(h.price) : '', why: c.text }));
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

// ---- score: how warm is this person right now ----
function scoreOf({ browse, events, lofty: la, alertsOn, emailOn, together, valueAsk }, now) {
  const win = now - 14 * DAY;
  const B = (browse || []).filter((e) => e.t > win), E = (events || []).filter((e) => e.t > win), L = (la || []).filter((a) => a.t > win);
  const n = (arr, k) => arr.filter((e) => e.k === k).length;
  const views = B.filter((e) => e.k === 'view');
  const perListing = {}; views.forEach((v) => { if (v.lid) perListing[v.lid] = (perListing[v.lid] || 0) + 1; });
  const repeats = Object.values(perListing).filter((c) => c >= 3).length;
  const secs = views.reduce((a, v) => a + (v.s || 0), 0);
  const ev = (k) => E.filter((e) => e.kind === k).length;
  const la_ = (t) => L.filter((a) => a.type === t).length;
  let raw = Math.min(views.length, 20) + Math.min(Math.floor(secs / 60), 10) + repeats * 5 + n(B, 'heart') * 3 + n(B, 'save') * 3
    + n(B, 'tour') * 15 + n(B, 'contact') * 10 + Math.min(n(B, 'search'), 5) + ev('ask') * 15 + ev('comment') * 2 + ev('love') + ev('add') * 3
    + Math.min(la_('Browse'), 10) + la_('Favorite') * 3 + la_('Request') * 15 + Math.min(la_('Search'), 5) + la_('Submission') * 10
    + (alertsOn ? 3 : 0) + (emailOn ? 3 : 0) + (together ? 5 : 0) + (valueAsk ? 10 : 0);
  const last = Math.max(0, ...B.map((e) => e.t), ...E.map((e) => e.t), ...L.map((a) => a.t));
  const days = last ? (now - last) / DAY : 99;
  const mult = days <= 2 ? 1 : days <= 7 ? 0.7 : days <= 14 ? 0.4 : 0.2;
  const score = Math.round(raw * mult);
  const why = [];
  if (n(B, 'tour') || la_('Request')) why.push('clicked to tour');
  if (ev('ask')) why.push('asked a question');
  if (repeats) why.push(`${repeats} home${repeats === 1 ? '' : 's'} viewed 3+ times`);
  if (views.length) why.push(`${views.length} listing views`);
  if (n(B, 'heart') + la_('Favorite')) why.push(`${n(B, 'heart') + la_('Favorite')} hearts`);
  if (valueAsk) why.push('asked what their home is worth');
  if (together) why.push('shopping with someone');
  const prices = views.map((v) => v.p).filter(Boolean).sort((a, b) => a - b);
  const range = !prices.length ? '' : prices[0] === prices[prices.length - 1] ? money(prices[0]) : `${money(prices[0])} to ${money(prices[prices.length - 1])}`;
  return { score, tier: score >= 40 ? 'Hot' : score >= 15 ? 'Warm' : 'Watch', why, range, lastActive: last };
}

function loftyLines(la, since) {
  const L = (la || []).filter((a) => a.t > since);
  if (!L.length) return [];
  const by = (t) => L.filter((a) => a.type === t);
  const lines = [];
  const addr = (xs) => [...new Set(xs.map((a) => (a.address || a.text || '').split(',')[0]).filter(Boolean))].slice(0, 5).join(', ');
  if (by('Browse').length) lines.push(`Lofty saw ${by('Browse').length} listing view${by('Browse').length === 1 ? '' : 's'}${addr(by('Browse')) ? ': ' + addr(by('Browse')) : ''}`);
  if (by('Favorite').length) lines.push(`Lofty favorites: ${addr(by('Favorite')) || by('Favorite').length}`);
  if (by('Request').length) lines.push(`Lofty showing requests: ${addr(by('Request')) || by('Request').length}`);
  if (by('Submission').length) lines.push(`Lofty form submissions: ${by('Submission').map((a) => a.text || a.link).filter(Boolean).slice(0, 3).join(', ') || by('Submission').length}`);
  return lines;
}

async function followUp(person, sc, report) {
  // One open follow-up at a time: Hot gets a call today, Warm a call in 3 days.
  const now = Date.now();
  const gap = sc.tier === 'Hot' ? 3 * DAY : 7 * DAY;
  if (!person.leadId || sc.tier === 'Watch' || (person.lastTaskAt && now - person.lastTaskAt < gap)) return null;
  const hourCT = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }));
  const when = sc.tier === 'Hot'
    ? (hourCT < 16 ? { startAt: lofty.ctAt(0, 16, 30), endAt: lofty.ctAt(0, 17, 0) } : { startAt: lofty.ctAt(1, 10, 0), endAt: lofty.ctAt(1, 10, 30) })
    : { startAt: lofty.ctAt(3, 10, 0), endAt: lofty.ctAt(3, 10, 30) };
  const content = `StyleDNA ${sc.tier} (score ${sc.score}): ${sc.why.join(', ') || 'active this week'}${sc.range ? '. Browsing ' + sc.range : ''}`;
  const taskId = await lofty.createTask(person.leadId, { content, type: 'Call', startAt: when.startAt, endAt: when.endAt });
  if (taskId) report.tasks++;
  return taskId ? now : null;
}

async function writeNotes(report, only, onlyVisitor) {
  const now = Date.now();
  const date = new Date(now).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric' });
  for (const id of (only ? [only] : (onlyVisitor ? [] : await store.listIds()))) {
    const cur = await store.read(id);
    if (!cur) continue;
    const b = cur.doc;
    const upd = {};
    const people = (b.members || []).filter((m) => m.role !== 'agent');
    for (const m of people) {
      const since = Math.max(m.notedAt || 0, now - 3 * DAY);
      const la = m.leadId ? await lofty.activities(m.leadId) : [];
      const mine = (b.browse || []).filter((e) => e.pid === m.pid), myEv = (b.events || []).filter((e) => e.by === m.pid);
      const sc = scoreOf({ browse: mine, events: myEv, lofty: la, alertsOn: (b.subs || []).some((x) => x.pid === m.pid),
        emailOn: (b.emails || []).some((x) => x.pid === m.pid && x.confirmed), together: people.length > 1, valueAsk: !!m.home }, now);
      report.people.push({ name: m.name, board: b.name, linked: !!m.leadId, ...sc });
      const u = { score: sc.score, tier: sc.tier };
      const lines = [...summarize(mine, myEv, since), ...loftyLines(la, since)];
      if (m.leadId && lines.length) {
        if (m.home) lines.push(`Current home: ${m.home.full || m.home.address}${sc.range ? ' | browsing ' + sc.range : ''}`);
        const ok = await lofty.addNote(m.leadId, [`StyleDNA activity, ${date} (${b.name}):`, ...lines.map((l) => '- ' + l), `StyleDNA score: ${sc.score} (${sc.tier})`, `Board: https://homestyledna.com/board.html?id=${b.id}`].join('\n'));
        if (ok) { u.notedAt = now; report.notes++; }
      }
      const t = await followUp(Object.assign({}, m, { lastTaskAt: Math.max(m.lastTaskAt || 0, (b.hot || {})['task|' + m.pid] || 0) }), sc, report);
      if (t) u.lastTaskAt = t;
      upd[m.pid] = u;
    }
    await store.update(id, (doc) => { (doc.members || []).forEach((m) => { if (upd[m.pid]) Object.assign(m, upd[m.pid]); }); });
  }
  for (const vid of (onlyVisitor ? [onlyVisitor] : (only ? [] : await store.listSpace('visitors')))) {
    const cur = await store.readIn('visitors', vid);
    if (!cur || !cur.doc.leadId) continue;
    const v = cur.doc;
    const since = Math.max(v.notedAt || 0, now - 3 * DAY);
    const la = await lofty.activities(v.leadId);
    const sc = scoreOf({ browse: v.browse, events: [], lofty: la, valueAsk: !!v.home }, now);
    report.people.push({ name: v.name || 'Quiz taker ' + v.leadId, board: '', linked: true, ...sc });
    const lines = [...summarize(v.browse, [], since), ...loftyLines(la, since)];
    const u = { score: sc.score, tier: sc.tier };
    if (lines.length) {
      if (v.home) lines.push(`Current home: ${v.home.full || v.home.address}${sc.range ? ' | browsing ' + sc.range : ''}`);
      const ok = await lofty.addNote(v.leadId, [`StyleDNA activity, ${date}:`, ...lines.map((l) => '- ' + l), `StyleDNA score: ${sc.score} (${sc.tier})`].join('\n'));
      if (ok) { u.notedAt = now; report.notes++; }
    }
    const t = await followUp(Object.assign({}, v, { lastTaskAt: Math.max(v.lastTaskAt || 0, (v.hot || {})['task|'] || 0) }), sc, report);
    if (t) u.lastTaskAt = t;
    await store.upsert('visitors', vid, (doc) => { Object.assign(doc, u); });
  }
}

// ---- the morning email to Josh: who's hot, what went out, anything broken ----
async function healthReport(report) {
  const now = Date.now();
  let boards = 0, members = 0, linked = 0, emailOn = 0, pushOn = 0, views24 = 0, searches24 = 0, hearts7 = 0, active24 = new Set();
  for (const id of await store.listIds()) {
    const cur = await store.read(id); if (!cur) continue;
    const b = cur.doc; boards++;
    (b.members || []).forEach((m) => { members++; if (m.leadId) linked++; });
    emailOn += (b.emails || []).filter((e) => e.confirmed).length; pushOn += (b.subs || []).length;
    (b.browse || []).forEach((e) => { if (e.t > now - DAY) { if (e.k === 'view') views24++; if (e.k === 'search') searches24++; active24.add(id + e.pid); } if (e.t > now - 7 * DAY && e.k === 'heart') hearts7++; });
  }
  for (const vid of await store.listSpace('visitors')) {
    const cur = await store.readIn('visitors', vid); if (!cur) continue;
    (cur.doc.browse || []).forEach((e) => { if (e.t > now - DAY) { if (e.k === 'view') views24++; if (e.k === 'search') searches24++; active24.add('v' + vid); } if (e.t > now - 7 * DAY && e.k === 'heart') hearts7++; });
  }
  const hot = report.people.filter((p) => p.tier === 'Hot').sort((a, b) => b.score - a.score);
  const warm = report.people.filter((p) => p.tier === 'Warm').sort((a, b) => b.score - a.score);
  const line = (p) => `${p.name}${p.board ? ' (' + p.board + ')' : ''}: score ${p.score}. ${p.why.join(', ')}${p.range ? '. Browsing ' + p.range : ''}${p.linked ? '' : '. Not in Lofty yet'}`;
  const problems = [];
  if (report.error) problems.push('Daily job error: ' + report.error);
  if (report.lookupOk === false) problems.push("Lofty didn't answer every listing lookup, so off-market checks were skipped today.");
  if (views24 >= 20 && hearts7 === 0) problems.push("Lots of views but no Lofty hearts seen this week. Lofty may have changed its page; the heart hook may need a look.");
  const body = [
    hot.length ? 'HOT' : '', ...hot.map(line), warm.length ? '' : null, warm.length ? 'WARM' : '', ...warm.slice(0, 8).map(line),
    '', `Listing updates sent: ${report.changes.length}${report.changes.length ? ' (' + report.changes.slice(0, 5).join(' ') + ')' : ''}`,
    `Lofty notes written: ${report.notes}. Follow-up tasks created: ${report.tasks}.${report.recaps ? ' Weekly recaps sent: ' + report.recaps + '.' : ''}${report.nudges ? ' Invite nudges sent: ' + report.nudges + '.' : ''}${report.backup ? ' Backup saved: ' + report.backup + '.' : ''}`,
    `Last 24 hours on joshwaters.com: ${views24} listing views and ${searches24} searches from ${active24.size} StyleDNA ${active24.size === 1 ? 'person' : 'people'}. Hearts this week: ${hearts7}.`,
    `Boards: ${boards}, members: ${members}, linked to Lofty: ${linked}. Email alerts on: ${emailOn}. Phone alerts on: ${pushOn}.`,
    problems.length ? '' : 'Everything checked out.', ...problems,
  ].filter((l) => l !== null && l !== undefined);
  const date = new Date(now).toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric' });
  const subject = `StyleDNA ${date}: ${hot.length} hot, ${warm.length} warm${problems.length ? ', needs a look' : ''}`;
  const sent = await hotLib.emailJosh(subject, body, 'https://homestyledna.com/');
  report.reportSent = sent;
  await store.upsert('stats', 'latest00', (doc) => { doc.report = { at: now, hot: hot.slice(0, 20), warm: warm.slice(0, 30), views24, searches24, active24: active24.size, hearts7, boards, members, linked, emailOn, pushOn, problems }; });
}

// ---- Monday recap: one short email per board member with email alerts on ----
async function weeklyRecap(report, only) {
  const now = Date.now(), wk = now - 7 * DAY;
  for (const id of (only ? [only] : await store.listIds())) {
    const cur = await store.read(id); if (!cur) continue;
    const b = cur.doc;
    if (!(b.emails || []).some((e) => e.confirmed)) continue;
    const added = (b.homes || []).filter((h) => h.addedAt > wk);
    const changed = (b.homes || []).filter((h) => (h.changes || []).some((c) => c.t > wk));
    const opens = (b.homes || []).filter((h) => h.openHouse && ctTime(h.openHouse.end || h.openHouse.start) > now && ctTime(h.openHouse.start) < now + 7 * DAY && !/sold|off market/i.test(h.status || ''));
    if (!added.length && !changed.length && !opens.length) continue;
    const seen = new Set(), homes = [];
    const push = (h, change, why) => { if (seen.has(h.id)) return; seen.add(h.id); homes.push({ url: h.url || '', address: h.address, office: h.office || '', change, price: h.price ? money(h.price) : '', why }); };
    opens.forEach((h) => push(h, 'Open house', h.openHouse.text));
    changed.forEach((h) => { const c = h.changes.find((x) => x.t > wk); push(h, (h.lastChange && h.lastChange.label) || 'Update', c.text); });
    added.forEach((h) => push(h, h.source === 'josh' ? "Josh's pick" : 'New on your board', ''));
    const bits = [added.length && `${added.length} new home${added.length === 1 ? '' : 's'}`, changed.length && `${changed.length} update${changed.length === 1 ? '' : 's'}`, opens.length && `${opens.length} open house${opens.length === 1 ? '' : 's'}`].filter(Boolean);
    const sent = await mailer.alertBoard(b, null, { kind: 'update', homes: homes.slice(0, 8), reason: `Your week on ${b.name}: ${bits.join(', ')}.`, subject: `Your week: ${bits.join(', ')}` });
    report.recaps += sent.length;
  }
}

// ---- nudge a solo board owner to invite their partner (once, after 3 days) ----
async function partnerNudge(report, only) {
  const now = Date.now();
  for (const id of (only ? [only] : await store.listIds())) {
    const cur = await store.read(id); if (!cur) continue;
    const b = cur.doc;
    const people = (b.members || []).filter((m) => m.role !== 'agent');
    if (people.length !== 1 || b.nudgedAt || now - (b.createdAt || now) < 3 * DAY) continue;
    const owner = people[0];
    const e = (b.emails || []).find((x) => x.pid === owner.pid && x.confirmed);
    if (!e) continue;
    const solo = Object.assign({}, b, { emails: [e] });
    const sent = await mailer.alertBoard(solo, null, { kind: 'update', homes: [], subject: 'Shopping with someone?',
      reason: 'Boards work best together. Invite the person you\'re buying with so you can both heart, pass and comment, and see the homes you both love. Open your board and tap Invite.' });
    if (sent.length) { report.nudges++; await store.update(id, (doc) => { doc.nudgedAt = now; }); }
  }
}

// ---- weekly backup of every board, visitor and sharer record ----
async function backup(report) {
  const data = { at: Date.now(), boards: [], visitors: [], sharers: [] };
  for (const id of await store.listIds()) { const c = await store.read(id); if (c) data.boards.push(c.doc); }
  for (const id of await store.listSpace('visitors')) { const c = await store.readIn('visitors', id); if (c) data.visitors.push(c.doc); }
  for (const id of await store.listSpace('sharers')) { const c = await store.readIn('sharers', id); if (c) data.sharers.push(Object.assign({ sid: id }, c.doc)); }
  const key = 'b' + new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }).replace(/-/g, '');
  await store.upsert('backups', key, (doc) => { doc.data = data; });
  report.backup = `${data.boards.length} boards, ${data.visitors.length} visitors`;
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
  const report = { part, changes: [], notes: 0, tasks: 0, people: [], recaps: 0, nudges: 0 };
  // Nightly quiz pool: every county, photos read for new listings. Test site can run one county.
  if (part === 'pool') {
    const started = Date.now();
    const only1 = process.env.VERCEL_ENV === 'production' ? null : (q.county || null);
    const list = only1 ? [only1] : Object.keys(require('./_lib/styles').COUNTIES);
    let budget = Number(q.budget) || 1500; report.pool = [];
    for (const c of list) {
      const left = 270000 - (Date.now() - started);
      if (left < 30000) { report.pool.push({ county: c, skipped: 'out of time' }); continue; }
      try { const r = await poolLib.buildCounty(c, budget, Math.min(left - 25000, 120000)); report.pool.push(r); budget = Math.max(0, budget - (r.read || 0)); } catch (e) { report.pool.push({ county: c, error: String(e && e.message) }); }
    }
    console.log('pool run', JSON.stringify(report.pool));
    return res.status(200).json(report);
  }
  try {
    if (part === 'all' || part === 'listings') await checkListings(report, only);
    if (part === 'all' || part === 'notes') await writeNotes(report, only, onlyVisitor);
    const dow = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short' });
    if ((part === 'all' && dow === 'Mon') || q.recap) await weeklyRecap(report, only);
    if (part === 'all' || q.nudge) await partnerNudge(report, only);
    if ((part === 'all' && dow === 'Sun') || q.backup) await backup(report);
    if (part === 'all' && (process.env.VERCEL_ENV === 'production' || q.report)) await healthReport(report);
  } catch (e) {
    console.error('daily job failed', e && e.message);
    report.error = String(e && e.message);
  }
  console.log('daily job', JSON.stringify(report).slice(0, 2000));
  return res.status(200).json(report);
};
