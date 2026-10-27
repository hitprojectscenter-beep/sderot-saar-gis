// Storage for features, photos and base layers.
// Production: a private Vercel Blob store (BLOB_READ_WRITE_TOKEN is set when the store is connected).
// Local development without a token: files under ./.data.
//
// All features live in ONE JSON document. Reads are cheap (conditional GET with ETag → 304),
// and every write is a compare-and-swap (ifMatch), so two commanders saving at the same
// moment never overwrite each other.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const useBlob = !!process.env.BLOB_READ_WRITE_TOKEN;
let blob;
async function blobApi() {
  if (!blob) blob = await import('@vercel/blob');
  return blob;
}

const DATA_DIR = path.resolve(process.cwd(), '.data');
const etagOf = (buf) => `"${createHash('sha1').update(buf).digest('hex')}"`;

export class ConflictError extends Error {}

/** Read a stored object. Returns { status: 200, body: Buffer, etag, contentType } | { status: 304, etag } | null. */
export async function readObject(pathname, { ifNoneMatch } = {}) {
  if (useBlob) {
    const { get } = await blobApi();
    const res = await get(pathname, { access: 'private', useCache: false, ...(ifNoneMatch ? { ifNoneMatch } : {}) });
    if (!res) return null;
    if (res.statusCode === 304) return { status: 304, etag: res.blob.etag };
    const body = Buffer.from(await new Response(res.stream).arrayBuffer());
    return { status: 200, body, etag: res.blob.etag, contentType: res.blob.contentType };
  }
  const file = path.join(DATA_DIR, pathname);
  try {
    const body = await readFile(file);
    const etag = etagOf(body);
    if (ifNoneMatch && ifNoneMatch === etag) return { status: 304, etag };
    const ext = path.extname(pathname).slice(1);
    const contentType = { json: 'application/json', png: 'image/png', webp: 'image/webp' }[ext] || 'image/jpeg';
    return { status: 200, body, etag, contentType };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Write an object. With ifMatch, the write only succeeds if the stored copy is unchanged
 * (ifMatch: null means "must not exist yet"); otherwise ConflictError is thrown.
 */
export async function writeObject(pathname, body, { contentType = 'application/json', ifMatch } = {}) {
  if (useBlob) {
    const { put, BlobPreconditionFailedError } = await blobApi();
    const opts = { access: 'private', contentType, addRandomSuffix: false, cacheControlMaxAge: 60 };
    if (ifMatch) opts.ifMatch = ifMatch;
    else opts.allowOverwrite = ifMatch !== null;
    try {
      const r = await put(pathname, body, opts);
      return { etag: r.etag };
    } catch (e) {
      const isConflict = (BlobPreconditionFailedError && e instanceof BlobPreconditionFailedError)
        || /precondition|already exists/i.test(e.message || '');
      if (isConflict) throw new ConflictError(e.message);
      throw e;
    }
  }
  // Local files: serialize writes so the etag check and the write are atomic within this process.
  const run = fsQueue.then(async () => {
    const file = path.join(DATA_DIR, pathname);
    await mkdir(path.dirname(file), { recursive: true });
    if (ifMatch !== undefined) {
      const current = await readObject(pathname);
      const currentTag = current ? current.etag : null;
      if (currentTag !== ifMatch) throw new ConflictError('etag mismatch');
    }
    await writeFile(file, body);
    return { etag: etagOf(Buffer.isBuffer(body) ? body : Buffer.from(body)) };
  });
  fsQueue = run.catch(() => {});
  return run;
}
let fsQueue = Promise.resolve();

export const FEATURES_PATH = 'state/features.json';
export const BASE_PATH = 'state/base-osm.json';

/** Load the features document: { features: { [id]: feature }, updatedAt }. */
export async function loadFeatures() {
  const obj = await readObject(FEATURES_PATH);
  if (!obj) return { doc: { features: {}, updatedAt: null }, etag: null };
  return { doc: JSON.parse(obj.body.toString('utf8')), etag: obj.etag };
}

/**
 * Apply `mutate(doc)` to the features document with optimistic concurrency.
 * Retries on conflict, re-reading the latest copy each time.
 */
export async function updateFeatures(mutate, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    const { doc, etag } = await loadFeatures();
    const result = mutate(doc);
    doc.updatedAt = new Date().toISOString();
    try {
      const { etag: newEtag } = await writeObject(FEATURES_PATH, JSON.stringify(doc), { ifMatch: etag });
      return { result, etag: newEtag };
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
      await new Promise((r) => setTimeout(r, 80 + Math.random() * 200 * (i + 1)));
    }
  }
  throw new Error('השרת עמוס – נסו שוב בעוד רגע');
}
