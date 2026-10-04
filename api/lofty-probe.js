// Preview-only: shows the raw shape of Lofty listing and activity responses so the
// listing-change check can be built on real field names. Never runs on the live site.
module.exports = async (req, res) => {
  if (process.env.VERCEL_ENV !== 'preview') return res.status(404).json({ error: 'not_found' });
  const key = process.env.LOFTY_API_KEY;
  const q = req.query || {};
  if (q.token) return res.status(200).json({ id: q.token, t: require('./_lib/lofty').leadToken(q.token) });
  let url;
  if (q.mls) url = 'https://api.lofty.com/v1.0/listing?limit=5&mlsListingIds=' + encodeURIComponent(q.mls);
  else if (q.lead) url = 'https://api.lofty.com/v1.0/leads/' + encodeURIComponent(q.lead) + '/activities';
  else if (q.find) url = 'https://api.lofty.com/v1.0/leads?keyword=' + encodeURIComponent(q.find) + '&limit=5';
  else return res.status(400).json({ error: 'need mls, lead or find' });
  const r = await fetch(url, { headers: { Authorization: 'token ' + key, Accept: 'application/json' } });
  let r2 = null;
  if (r.status === 401 || r.status === 403) r2 = await fetch(url, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } });
  const out = r2 || r;
  const text = await out.text();
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).send(JSON.stringify({ status: out.status, authTried: r2 ? 'bearer' : 'token', body: text.slice(0, 20000) }));
};
