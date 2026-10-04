// Preview-only helper for setting up the StyleDNA sending address in Resend.
// Never runs on the live site. Test sends go only to Josh.
const API = 'https://api.resend.com';
const SEND_DOMAIN = process.env.RESEND_EMAIL_DOMAIN || 'homestyledna.com';
const TEST_TO = 'josh@dallascollectivegroup.com';

async function rs(path, method, body) {
  const r = await fetch(API + path, {
    method: method || 'GET',
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: r.status, data };
}

module.exports = async (req, res) => {
  if (process.env.VERCEL_ENV !== 'preview') return res.status(404).json({ error: 'not_found' });
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'no_key' });
  const a = (req.query && req.query.a) || 'list';
  try {
    if (a === 'list') return res.json(await rs('/domains'));
    if (a === 'create') return res.json(await rs('/domains', 'POST', { name: SEND_DOMAIN, region: 'us-east-1' }));
    if (a === 'get') return res.json(await rs('/domains/' + encodeURIComponent(req.query.id)));
    if (a === 'verify') return res.json(await rs('/domains/' + encodeURIComponent(req.query.id) + '/verify', 'POST'));
    if (a === 'tracking') return res.json(await rs('/domains/' + encodeURIComponent(req.query.id), 'PATCH', { open_tracking: false, click_tracking: false }));
    if (a === 'test') {
      const { renderAlert } = require('./_lib/alert-email');
      const m = renderAlert({
        name: 'Josh', boardName: "Josh's home board", boardUrl: 'https://homestyledna.com/board.html',
        homes: [{ address: '9105 Norman Dr, Plano', price: 'Test listing', why: 'This is a test of the StyleDNA alert email.' }],
        unsubUrl: 'https://homestyledna.com/api/email?a=unsub&t=test',
      });
      return res.json(await rs('/emails', 'POST', {
        from: 'StyleDNA <alerts@' + SEND_DOMAIN + '>', to: [TEST_TO], reply_to: TEST_TO,
        subject: m.subject, html: m.html, text: m.text, headers: m.headers,
      }));
    }
    return res.status(400).json({ error: 'bad_action' });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
};
