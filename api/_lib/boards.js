// Home board storage. One private JSON document per board in Vercel Blob (boards/<id>.json).
// Writes use the blob's ETag so two people saving at the same moment never overwrite each other:
// the second write fails, re-reads and tries again.
// For local tests set BOARD_STORE_DIR to a folder and the same API works on plain files.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LOCAL_DIR = process.env.BOARD_STORE_DIR || '';
let blob = null;
function blobLib() {
  if (!blob) blob = require('@vercel/blob');
  return blob;
}

const keyFor = (id) => `boards/${id}.json`;
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9]{8,24}$/.test(id);

function newId(len = 12) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += abc[bytes[i] % abc.length];
  return out;
}

async function streamToString(stream) {
  const chunks = [];
  const reader = stream.getReader ? stream.getReader() : null;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
  } else {
    for await (const c of stream) chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function read(id) {
  if (!validId(id)) return null;
  if (LOCAL_DIR) {
    const f = path.join(LOCAL_DIR, id + '.json');
    if (!fs.existsSync(f)) return null;
    const text = fs.readFileSync(f, 'utf8');
    return { doc: JSON.parse(text), etag: crypto.createHash('md5').update(text).digest('hex') };
  }
  // The ETag comes from head() (the storage API's own ETag, which put's ifMatch checks), taken
  // before the content is read. If the board changes in between, the write is refused and retried.
  let etag = '';
  try {
    const h = await blobLib().head(keyFor(id));
    etag = h && h.etag;
  } catch (err) {
    if (err && err.name === 'BlobNotFoundError') return null;
    throw err;
  }
  const r = await blobLib().get(keyFor(id), { access: 'private', useCache: false });
  if (!r) return null;
  const text = await streamToString(r.stream);
  return { doc: JSON.parse(text), etag };
}

async function write(id, doc, etag) {
  const text = JSON.stringify(doc);
  if (LOCAL_DIR) {
    const f = path.join(LOCAL_DIR, id + '.json');
    if (etag && fs.existsSync(f)) {
      const now = crypto.createHash('md5').update(fs.readFileSync(f, 'utf8')).digest('hex');
      if (now !== etag) { const e = new Error('precondition'); e.precondition = true; throw e; }
    }
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    fs.writeFileSync(f, text);
    return;
  }
  const opts = { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60 };
  if (etag) opts.ifMatch = etag;
  try {
    await blobLib().put(keyFor(id), text, opts);
  } catch (err) {
    if (err && (err.name === 'BlobPreconditionFailedError' || /precondition/i.test(err.message || ''))) {
      console.warn('board write conflict, retrying', id);
      const e = new Error('precondition'); e.precondition = true; throw e;
    }
    throw err;
  }
}

async function create(doc) {
  for (let i = 0; i < 3; i++) {
    const id = newId();
    if (!(await read(id))) {
      doc.id = id;
      await write(id, doc, null);
      return doc;
    }
  }
  throw new Error('could not create board');
}

// Load, change, save; retried when someone else saved first.
async function update(id, change) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await read(id);
    if (!cur) return null;
    const result = await change(cur.doc);
    // false = nothing to save; a string = a refusal reason ('forbidden', 'full' ...), also nothing to save.
    if (result === false || typeof result === 'string') return { doc: cur.doc, result, unchanged: true };
    cur.doc.updatedAt = Date.now();
    try {
      await write(id, cur.doc, cur.etag);
      return { doc: cur.doc, result };
    } catch (err) {
      if (!err.precondition) throw err;
      await new Promise((r) => setTimeout(r, 80 + Math.random() * 200));
    }
  }
  throw new Error('busy');
}

async function listIds() {
  if (LOCAL_DIR) {
    if (!fs.existsSync(LOCAL_DIR)) return [];
    return fs.readdirSync(LOCAL_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  }
  const ids = [];
  let cursor;
  do {
    const r = await blobLib().list({ prefix: 'boards/', cursor, limit: 1000 });
    r.blobs.forEach((b) => { const m = b.pathname.match(/^boards\/([A-Za-z0-9]+)\.json$/); if (m) ids.push(m[1]); });
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return ids;
}

async function remove(id) {
  if (!validId(id)) return false;
  if (LOCAL_DIR) {
    const f = path.join(LOCAL_DIR, id + '.json');
    if (fs.existsSync(f)) fs.unlinkSync(f);
    return true;
  }
  await blobLib().del(keyFor(id));
  return true;
}

module.exports = { read, update, create, remove, listIds, newId, validId };
