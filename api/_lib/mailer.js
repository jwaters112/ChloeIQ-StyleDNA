// Sends StyleDNA emails through Resend. Only people who confirmed their address get alerts.
const { renderAlert, ADDRESS } = require('./alert-email');

const DOMAIN = process.env.RESEND_EMAIL_DOMAIN || 'homestyledna.com';
const FROM = `StyleDNA <alerts@${DOMAIN}>`;
const REPLY_TO = 'josh@dallascollectivegroup.com';
const BASE = process.env.VERCEL_ENV === 'production' ? 'https://homestyledna.com'
  : 'https://' + (process.env.VERCEL_BRANCH_URL || process.env.VERCEL_URL || 'homestyledna.com');
const THROTTLE_MS = 30 * 60 * 1000;

const EMAIL_RE = /^[^\s@<>()",;:]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const cleanEmail = (v) => { const s = String(v || '').trim().toLowerCase().slice(0, 120); return EMAIL_RE.test(s) ? s : ''; };

async function send(msg) {
  if (!process.env.RESEND_API_KEY) return { ok: false, error: 'no_key' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ from: FROM, reply_to: REPLY_TO }, msg)),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) console.warn('email send failed', r.status, (await r.text()).slice(0, 200));
    return { ok: r.ok };
  } catch (e) { console.warn('email send error', e && e.message); return { ok: false }; }
}

const boardLink = (b, m) => {
  const q = new URLSearchParams({ id: b.id });
  if (m) { q.set('p', m.pid); q.set('k', m.key); if (m.name) q.set('n', m.name); }
  return `${BASE}/board.html?${q}`;
};
const unsubLink = (b, e) => `${BASE}/api/email?a=unsub&b=${encodeURIComponent(b.id)}&t=${encodeURIComponent(e.token)}`;

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function sendConfirm(b, entry, member) {
  const url = `${BASE}/api/email?a=confirm&b=${encodeURIComponent(b.id)}&t=${encodeURIComponent(entry.token)}`;
  const name = member && member.name ? `Hi ${member.name},` : 'Hi,';
  const text = [name, '', `Tap below to turn on email alerts for ${b.name}.`, '', url, '',
    "If you didn't ask for this, ignore this email and nothing will be sent.", `StyleDNA, ${ADDRESS}`].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#F5F5F3;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:12px"><tr><td style="padding:28px;font-size:15px;line-height:1.55;color:#030C0D">
      <div style="font-size:18px;font-weight:600;font-style:italic;margin-bottom:18px">Style<span style="color:#B8892B">DNA</span></div>
      <p style="margin:0 0 10px">${esc(name)}</p>
      <p style="margin:0 0 22px">Tap below to turn on email alerts for ${esc(b.name)}.</p>
      <p style="margin:0 0 22px;text-align:center"><a href="${esc(url)}" style="display:inline-block;background:#030C0D;color:#FFFFFF;text-decoration:none;font-weight:600;padding:13px 26px;border-radius:999px">Confirm email alerts</a></p>
      <p style="margin:0;font-size:13px;color:#5A5F5E">If you didn't ask for this, ignore this email and nothing will be sent.</p>
    </td></tr></table>
    <div style="max-width:520px;font-size:12px;color:#7A7F7E;padding:16px 8px 0">StyleDNA, ${ADDRESS}</div>
  </td></tr></table></body></html>`;
  return send({ to: [entry.email], subject: `Confirm email alerts for ${b.name}`, html, text });
}

// Send an alert to every confirmed member except the one who did the thing.
// Returns the pids that were emailed so the caller can record when.
async function alertBoard(b, exceptPid, { kind, homes, reason, subject }) {
  const now = Date.now();
  const list = (b.emails || []).filter((e) => e.confirmed && e.pid !== exceptPid
    && (kind === 'picks' || kind === 'update' || !e.lastSent || now - e.lastSent > THROTTLE_MS));
  const sent = [];
  await Promise.all(list.map(async (e) => {
    const m = (b.members || []).find((x) => x.pid === e.pid);
    if (!m) return;
    const board = boardLink(b, m);
    const frag = '#sdna=' + b.id + '.' + m.pid + '.' + m.key + '.' + encodeURIComponent(b.name || '');
    const mine = (homes || []).map((h) => Object.assign({}, h, {
      link: /^https:\/\/(www\.)?joshwaters\.com\/listing-detail\//.test(h.url || '') ? h.url.split('#')[0] + frag : board }));
    const msg = renderAlert({ name: m.name, boardName: b.name, boardUrl: board, homes: mine, unsubUrl: unsubLink(b, e), reason, subject });
    const r = await send({ to: [e.email], subject: msg.subject, html: msg.html, text: msg.text, headers: msg.headers });
    if (r.ok) sent.push(e.pid);
  }));
  return sent;
}

module.exports = { cleanEmail, sendConfirm, alertBoard, boardLink, BASE };
