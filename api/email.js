// Confirm and unsubscribe links from StyleDNA emails.
// GET  ?a=confirm&b=<board>&t=<token>  turns email alerts on and opens the board
// GET  ?a=unsub&b=<board>&t=<token>    turns them off and shows a short page
// POST ?a=unsub...                     one-click unsubscribe from the mail app's button
const store = require('./_lib/boards');
const { boardLink } = require('./_lib/mailer');

function page(res, title, body, link) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title} | StyleDNA</title>
<style>body{margin:0;min-height:100vh;background:radial-gradient(ellipse 80% 45% at 0% 0%,rgba(33,61,55,.55) 0%,rgba(14,41,38,.35) 35%,rgba(3,12,13,0) 75%),#030C0D;color:#F5F5F3;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif}
.w{max-width:420px;margin:0 auto;padding:24vh 24px 40px;text-align:center}.k{font-weight:600;font-style:italic;font-size:20px;margin:0 0 18px}.k b{color:#E0B24D}
h1{font-size:24px;font-weight:600;margin:0 0 12px}p{color:#A3A7A6;line-height:1.6;margin:0 0 24px}a{display:inline-block;background:#E0B24D;color:#030C0D;text-decoration:none;border-radius:999px;padding:14px 26px;font-weight:600}</style>
</head><body><div class="w"><p class="k">Style<b>DNA</b></p><h1>${title}</h1><p>${body}</p>${link ? `<a href="${link}">Open the board</a>` : ''}</div></body></html>`);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  const a = String(q.a || ''), id = String(q.b || ''), token = String(q.t || '').slice(0, 40);
  if (!store.validId(id) || !token) return page(res, 'That link has expired', 'Open your board and turn email alerts on again.', '');
  try {
    if (a === 'confirm') {
      let member = null;
      const out = await store.update(id, (b) => {
        const e = (b.emails || []).find((x) => x.token === token);
        if (!e) return 'missing';
        member = (b.members || []).find((m) => m.pid === e.pid) || null;
        if (e.confirmed) return false;
        e.confirmed = true; e.confirmedAt = Date.now();
      });
      if (!out || out.result === 'missing') return page(res, 'That link has expired', 'Open your board and turn email alerts on again.', '');
      res.setHeader('Location', boardLink(out.doc, member) + '&email=on');
      return res.status(302).end();
    }
    if (a === 'unsub') {
      let member = null;
      const out = await store.update(id, (b) => {
        const e = (b.emails || []).find((x) => x.token === token);
        if (!e) return 'missing';
        member = (b.members || []).find((m) => m.pid === e.pid) || null;
        b.emails = b.emails.filter((x) => x.token !== token);
      });
      if (req.method === 'POST') return res.status(200).json({ ok: true });
      const link = out && out.doc ? boardLink(out.doc, member) : '';
      return page(res, 'Email alerts are off', "You won't get any more emails about this board. You can turn them back on from the board anytime.", link);
    }
  } catch (e) {
    console.error('email link error', e && e.message);
  }
  return page(res, 'Something went wrong', 'Try the link again in a minute.', '');
};
