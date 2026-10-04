// StyleDNA alert email: short, mostly text, one button back to the board.
// Every send carries a plain-text copy, a postal address and one-click unsubscribe headers.
const ADDRESS = '2626 Cole Ave #300, Dallas, TX 75204';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderAlert({ name, boardName, boardUrl, homes, unsubUrl, reason, subject: subj }) {
  const n = (homes || []).length;
  const subject = subj || (n === 1 ? `A new home for ${boardName}` : `${n} new homes for ${boardName}`);
  const hi = name ? `Hi ${name},` : 'Hi,';
  const lead = reason || (n === 1 ? 'A home that fits your StyleDNA just came up.' : `${n} homes that fit your StyleDNA just came up.`);
  const rows = (homes || []).slice(0, 5).map(h => `
      <tr><td style="padding:14px 0;border-top:1px solid #E6E6E3">
        ${h.change ? `<div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#B8892B;margin-bottom:4px">${esc(h.change)}</div>` : ''}
        <div style="font-size:16px;font-weight:600">${h.link ? `<a href="${esc(h.link)}" style="color:#030C0D;text-decoration:underline">${esc(h.address)}</a>` : `<span style="color:#030C0D">${esc(h.address)}</span>`}</div>
        ${h.price ? `<div style="font-size:14px;color:#5A5F5E;margin-top:2px">${esc(h.price)}</div>` : ''}
        ${h.why ? `<div style="font-size:14px;color:#5A5F5E;margin-top:6px">${esc(h.why)}</div>` : ''}
        ${h.link ? `<div style="font-size:14px;margin-top:8px"><a href="${esc(h.link)}" style="color:#B8892B;font-weight:600;text-decoration:none">See photos and details</a></div>` : ''}
      </td></tr>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:#F5F5F3;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F3"><tr><td align="center" style="padding:28px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:12px">
      <tr><td style="padding:28px 28px 8px">
        <div style="font-size:18px;font-weight:600;font-style:italic;color:#030C0D">Style<span style="color:#B8892B">DNA</span></div>
      </td></tr>
      <tr><td style="padding:8px 28px 0;font-size:15px;line-height:1.55;color:#030C0D">
        <p style="margin:0 0 10px">${esc(hi)}</p>
        <p style="margin:0 0 16px">${esc(lead)}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
      </td></tr>
      <tr><td align="center" style="padding:22px 28px 30px">
        <a href="${esc(boardUrl)}" style="display:inline-block;background:#030C0D;color:#FFFFFF;text-decoration:none;font-weight:600;font-size:15px;padding:13px 26px;border-radius:999px">Open ${esc(boardName)}</a>
      </td></tr>
    </table>
    <div style="max-width:520px;font-size:12px;line-height:1.5;color:#7A7F7E;padding:16px 8px 0">
      You're getting this because you turned on email alerts for ${esc(boardName)}.
      <a href="${esc(unsubUrl)}" style="color:#7A7F7E">Turn off email alerts</a>.<br>
      StyleDNA, ${ADDRESS}
    </div>
  </td></tr></table></body></html>`;
  const text = [hi, '', lead, '',
    ...(homes || []).slice(0, 5).map(h => `- ${h.change ? h.change.toUpperCase() + ': ' : ''}${h.address}${h.price ? ' (' + h.price + ')' : ''}${h.why ? ': ' + h.why : ''}${h.link ? '\n  See photos and details: ' + h.link : ''}`),
    '', `Open ${boardName}: ${boardUrl}`, '',
    `You're getting this because you turned on email alerts for ${boardName}.`,
    `Turn off email alerts: ${unsubUrl}`, `StyleDNA, ${ADDRESS}`].join('\n');
  const headers = { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
  return { subject, html, text, headers };
}

module.exports = { renderAlert, ADDRESS };
