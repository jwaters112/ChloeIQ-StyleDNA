// Snippets the daily StyleDNA run pastes into Claude in Chrome (javascript_tool) on NTREIS Matrix.
// Each block is self-contained; copy the body of the function you need.

// 1. On a Matrix results page in the "Customer Brief" display (value 31), collect each listing's
//    front photo link and ZIP into sessionStorage key 'sdna_h' ({mls: {front, zip}}).
//    Run once per results page. Returns "<this page>/<total so far>".
function collectPage() {
  const out = {};
  for (const im of document.images) {
    if (im.naturalWidth < 200) continue;
    let n = im, m = null, text = '';
    for (let k = 0; k < 30 && n; k++) {
      n = n.parentElement; if (!n) break;
      text = n.innerText || '';
      const ms = [...new Set((text.match(/(?<!Lsc )MLS#:\s*\d{8}/g) || []).map(x => x.match(/\d{8}/)[0]))];
      if (ms.length === 1) { m = ms[0]; break; }
      if (ms.length > 1) break;
    }
    if (m && !out[m]) {
      const z = (text.match(/,\s*TX\s+(\d{5})/) || [])[1] || '';
      out[m] = { front: im.src, zip: z };
    }
  }
  const h = JSON.parse(sessionStorage.getItem('sdna_h') || '{}');
  Object.assign(h, out);
  sessionStorage.setItem('sdna_h', JSON.stringify(h));
  return Object.keys(out).length + '/' + Object.keys(h).length;
}

// 2. Hand the collected photos to the tagging page. This navigates the Matrix tab itself to the
//    preview site (a popup is unreliable). The links expire within the hour, so do this right
//    after collecting. Afterwards go back to Matrix with navigate.
function sendToTagger() {
  const h = JSON.parse(sessionStorage.getItem('sdna_h') || '{}');
  const homes = Object.entries(h).map(([mls, v]) => ({ mls, front: v.front }));
  location.href = 'https://homestyledna-git-quick-fixes-dallas-collective-group.vercel.app/tag-test.html?run=' + Date.now() +
    '#' + encodeURIComponent(JSON.stringify({ homes }));
  return homes.length;
}

// 3. On the tagging page, once it says "Done", read results in chunks of 50 (the tool truncates
//    long output). Call with start = 0, 50, 100 ...
function readResults(start) {
  return (window.__out || []).slice(start, start + 50)
    .map(r => r.mls + ':' + (r.ext || 'ERR') + ':' + (r.int || '-')).join(',');
}

// 4. On a Matrix page, before sendToTagger: read the collected ZIPs in chunks of 80.
function readZips(start) {
  const z = Object.entries(JSON.parse(sessionStorage.getItem('sdna_h') || '{}'));
  return z.slice(start, start + 80).map(([m, v]) => m + ':' + v.zip).join(',');
}

// 5. Home boards (run on any page of the preview site, which is behind Josh's Vercel sign-in).
//    adminList(): every board's criteria and the MLS numbers already on it, as one compact JSON
//    string. Read it in chunks with adminListChunk(0), adminListChunk(900) ... and save as boards.json.
async function adminList() {
  const r = await fetch('/api/board', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'admin-list' }) });
  const j = await r.json();
  window.__boards = JSON.stringify(j.boards || []);
  return (j.boards || []).length + ' boards, ' + window.__boards.length + ' chars';
}
function adminListChunk(start) { return (window.__boards || '').slice(start, start + 900); }

// 6. postPicks(picks): picks is the board-picks output ([{id, homes:[...]}]). Adds them to each board
//    as Josh's picks and sends one alert per board to members who turned alerts on.
async function postPicks(picks) {
  const out = [];
  for (const p of picks) {
    const r = await fetch('/api/board', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'admin-picks', id: p.id, homes: p.homes }) });
    const j = await r.json().catch(() => ({}));
    out.push(p.id + ':' + (j.ok ? j.added : 'ERR ' + r.status));
  }
  return out.join(',');
}
