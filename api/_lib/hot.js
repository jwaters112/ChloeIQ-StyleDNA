// Instant hot-lead alerts to Josh: an email to his inbox right away, plus a Lofty task and note
// when we know which lead it is. Callers decide when something is hot and pass a dedupe key so
// the same signal never alerts twice in a day.
const lofty = require('./lofty');

const JOSH = 'josh@dallascollectivegroup.com';
const DOMAIN = process.env.RESEND_EMAIL_DOMAIN || 'homestyledna.com';
const DAY = 86400000;

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function emailJosh(subject, lines, link) {
  if (!process.env.RESEND_API_KEY) return false;
  const text = [...lines, '', link ? 'Open: ' + link : ''].join('\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#030C0D;max-width:560px">
    ${lines.map((l) => `<p style="margin:0 0 8px">${esc(l)}</p>`).join('')}
    ${link ? `<p style="margin:16px 0 0"><a href="${esc(link)}" style="color:#B8892B;font-weight:600">Open</a></p>` : ''}</div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `StyleDNA <alerts@${DOMAIN}>`, to: [JOSH], subject, text, html }), signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch (e) { return false; }
}

// Due time for a hot follow-up: within the next couple of hours during the day, else 9:30 tomorrow.
function dueSoon() {
  const hourCT = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }));
  if (hourCT >= 8 && hourCT < 18) {
    const start = new Date(Date.now() + 60 * 60000);
    const iso = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');
    return { startAt: iso(start), endAt: iso(new Date(start.getTime() + 30 * 60000)) };
  }
  const tomorrow = hourCT >= 18 ? 1 : 0;
  return { startAt: lofty.ctAt(tomorrow, 9, 30), endAt: lofty.ctAt(tomorrow, 10, 0) };
}

// seen: an object kept on the board or visitor record ({ key: time }); returns false when already sent today.
function fresh(seen, key) {
  if (!seen) return true;
  if (seen[key] && Date.now() - seen[key] < DAY) return false;
  seen[key] = Date.now();
  Object.keys(seen).forEach((k) => { if (Date.now() - seen[k] > 7 * DAY) delete seen[k]; });
  return true;
}

// kind: tour, contact, repeat, back, match, ask, value
async function alert({ kind, who, leadId, headline, details, link, task }) {
  const name = who || 'A StyleDNA lead';
  const subject = `Hot: ${headline}`;
  const lines = [headline, ...(details || []), leadId ? '' : 'Not linked to a Lofty lead yet.'].filter((l) => l !== undefined);
  const out = { emailed: await emailJosh(subject, lines.filter(Boolean), link) };
  if (leadId) {
    await lofty.addNote(leadId, `StyleDNA hot signal: ${headline}${details && details.length ? '\n' + details.join('\n') : ''}`);
    if (task !== false) {
      const t = dueSoon();
      out.taskId = await lofty.createTask(leadId, { content: `StyleDNA hot: ${headline}`.slice(0, 300), type: 'Call', startAt: t.startAt, endAt: t.endAt });
    }
  }
  console.log('hot alert', kind, name, JSON.stringify(out));
  return out;
}

module.exports = { alert, fresh, emailJosh };
