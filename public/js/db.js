// Tiny IndexedDB wrapper: a key/value store and an ordered outbox of pending writes.
// Everything the app needs to keep working without network lives here.

const DB_NAME = 'saar-gis';
const VERSION = 1;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const req2promise = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export const kv = {
  get: (key) => tx('kv', 'readonly', (s) => req2promise(s.get(key))),
  set: (key, value) => tx('kv', 'readwrite', (s) => { s.put(value, key); }),
  del: (key) => tx('kv', 'readwrite', (s) => { s.delete(key); }),
};

export const outbox = {
  add: (entry) => tx('outbox', 'readwrite', (s) => { s.add({ ...entry, queuedAt: Date.now() }); }),
  all: () => tx('outbox', 'readonly', (s) => req2promise(s.getAll())),
  remove: (seqs) => tx('outbox', 'readwrite', (s) => { seqs.forEach((q) => s.delete(q)); }),
  put: (entry) => tx('outbox', 'readwrite', (s) => { s.put(entry); }),
  count: () => tx('outbox', 'readonly', (s) => req2promise(s.count())),
  clear: () => tx('outbox', 'readwrite', (s) => { s.clear(); }),
};
