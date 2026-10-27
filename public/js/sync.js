// Data layer of the app: talks to the API, keeps a local copy in IndexedDB,
// queues every change in an outbox while offline, and replays it when the network returns.
import { kv, outbox } from './db.js';
import { isEditorOnlyLayer } from './layers.js';

const POLL_MS = 45000;
const listeners = { change: new Set(), status: new Set(), auth: new Set(), notice: new Set() };

const state = {
  server: new Map(), // id → feature as last seen on the server
  events: new Map(), // id → incident in the event repository
  etag: null,
  pending: [], // outbox entries
  online: navigator.onLine,
  syncing: false,
  lastSync: null,
  error: null,
};

export function on(event, fn) { listeners[event].add(fn); return () => listeners[event].delete(fn); }
const emit = (event, data) => listeners[event].forEach((fn) => fn(data));

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (res.status === 401) { emit('auth', null); throw Object.assign(new Error('נדרשת התחברות מחדש'), { status: 401 }); }
  return res;
}

async function errorText(res) {
  try { return (await res.json()).error || res.statusText; } catch { return res.statusText; }
}

// ── auth ──
export async function login(username, password) {
  const res = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (!res.ok) throw new Error(await errorText(res));
  const { user } = await res.json();
  await kv.set('user', user);
  state.etag = null; // editors see more than viewers: fetch the full list again
  return user;
}

export async function logout() {
  try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* offline: just forget locally */ }
  await kv.del('user');
  state.etag = null;
  state.server = new Map([...state.server].filter(([, f]) => !isEditorOnlyLayer(f.layer))); // editor-only items leave the device
  await persistServer();
  publish();
}

/** The cached user (works offline); verified against the server when online. */
export async function restoreSession() {
  const cached = await kv.get('user');
  if (!navigator.onLine) return cached || null;
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (res.status === 401) { await kv.del('user'); return null; }
    if (res.ok) { const { user } = await res.json(); await kv.set('user', user); return user; }
  } catch { /* network flake: fall back to cache */ }
  return cached || null;
}

// ── features ──
export async function init() {
  const saved = await kv.get('features');
  if (saved) {
    state.server = new Map(saved.features.map((f) => [f.id, f]));
    state.events = new Map((saved.events || []).map((e) => [e.id, e]));
    state.etag = saved.etag;
    state.lastSync = saved.lastSync;
  }
  state.pending = await outbox.all();
  window.addEventListener('online', () => { state.online = true; sync(); });
  window.addEventListener('offline', () => { state.online = false; publishStatus(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
  setInterval(() => { if (!document.hidden) sync(); }, POLL_MS);
  publish();
  sync();
}

/**
 * Server features with queued local changes applied on top.
 * Items of an incident are kept after deletion (deletedAt) for the replay; callers hide them.
 */
export function features() {
  const merged = new Map(state.server);
  for (const e of state.pending) {
    if (e.type !== 'op') continue;
    if (e.op.op === 'delete') {
      const f = merged.get(e.op.id);
      if (f?.eventId) merged.set(f.id, { ...f, deletedAt: e.op.at, pending: true });
      else merged.delete(e.op.id);
    } else if (e.op.op === 'upsert') {
      const prev = merged.get(e.op.feature.id);
      const local = { ...prev, ...e.op.feature, pending: true };
      delete local.deletedAt;
      if (local.eventId) {
        const state0 = { layer: local.layer, name: local.name, geometry: local.geometry };
        local.history = [...(prev?.history || []), { t: e.op.feature.observedAt, action: prev ? 'עדכון' : 'יצירה', state: state0 }];
        local.observedAt = prev?.observedAt || e.op.feature.observedAt;
      }
      merged.set(local.id, local);
    }
  }
  return [...merged.values()];
}

/** The event repository, with incidents opened or closed offline applied on top. Newest first. */
export function events() {
  const merged = new Map(state.events);
  for (const e of state.pending) {
    if (e.type !== 'op' || e.op.op !== 'event') continue;
    const ev = e.op.event;
    const prev = merged.get(ev.id);
    if (ev.action === 'open') merged.set(ev.id, prev || { id: ev.id, name: ev.name, type: ev.type, description: ev.description, status: 'active', startedAt: ev.at, createdBy: ev.by, pending: true });
    else if (prev) {
      const next = { ...prev, pending: true };
      if (ev.action === 'close') { next.status = 'closed'; next.endedAt = ev.at; }
      if (ev.action === 'reopen') { next.status = 'active'; delete next.endedAt; }
      if (ev.action === 'update') Object.assign(next, { name: ev.name || prev.name, type: ev.type, description: ev.description });
      merged.set(ev.id, next);
    }
  }
  return [...merged.values()].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
}

/** Open / update / close / reopen an incident. Returns its id. */
export async function saveEvent(event, action, user) {
  const ev = { ...event, id: event.id || uuid(), action, at: new Date().toISOString(), by: { username: user.username, label: user.label } };
  await queue({ type: 'op', op: { op: 'event', event: ev } });
  return ev.id;
}

export function getFeature(id) { return features().find((f) => f.id === id); }

function publish() { emit('change', features()); publishStatus(); }
function publishStatus() {
  emit('status', {
    online: state.online,
    pending: state.pending.filter((e) => e.type === 'op').length,
    pendingPhotos: state.pending.filter((e) => e.type === 'photo').length,
    syncing: state.syncing,
    lastSync: state.lastSync,
    error: state.error,
  });
}

async function persistServer() {
  await kv.set('features', { features: [...state.server.values()], events: [...state.events.values()], etag: state.etag, lastSync: state.lastSync });
}

/** Queue a create/update. `user` fills the optimistic local copy until the server answers. */
export async function saveFeature(feature, user) {
  const now = new Date().toISOString();
  const local = {
    ...feature,
    updatedAt: now,
    updatedBy: { username: user.username, label: user.label },
    createdAt: feature.createdAt || now,
    createdBy: feature.createdBy || { username: user.username, label: user.label },
    observedAt: now, // when it was seen in the field; the server keeps it even if this syncs hours later
  };
  await queue({ type: 'op', op: { op: 'upsert', feature: local } });
}

export async function deleteFeature(id) { await queue({ type: 'op', op: { op: 'delete', id, at: new Date().toISOString() } }); }

/** Store a photo locally (viewable offline at once) and queue its upload. Returns its id. */
export async function addPhoto(dataUrl) {
  const id = `${uuid()}_jpg`;
  await kv.set(`photo:${id}`, dataUrl);
  await queue({ type: 'photo', id, data: dataUrl });
  return id;
}

/** URL to show a photo: the local copy while it waits for upload, otherwise the API. */
export async function photoUrl(id) {
  const local = await kv.get(`photo:${id}`);
  return local || `/api/photo?id=${encodeURIComponent(id)}`;
}

async function queue(entry) {
  await outbox.add(entry);
  state.pending = await outbox.all();
  publish();
  sync();
}

let syncPromise = null;
export function sync() {
  if (!syncPromise) syncPromise = doSync().finally(() => { syncPromise = null; });
  return syncPromise;
}

async function doSync() {
  if (!navigator.onLine) { state.online = false; publishStatus(); return; }
  state.syncing = true;
  state.error = null;
  publishStatus();
  try {
    await pushPhotos();
    await pushOps();
    await pull();
    state.online = true;
  } catch (e) {
    state.error = e.status === 401 ? 'נדרשת התחברות מחדש' : (e.message || 'שגיאת סנכרון');
    if (e instanceof TypeError) { state.online = false; state.error = null; } // fetch failed: no network
  } finally {
    state.syncing = false;
    publish();
  }
}

async function pushPhotos() {
  for (const e of state.pending.filter((p) => p.type === 'photo')) {
    const res = await api('/api/photo', { method: 'POST', body: JSON.stringify({ id: e.id.replace(/_jpg$/, ''), data: e.data }) });
    if (!res.ok) throw new Error(`העלאת תמונה נכשלה: ${await errorText(res)}`);
    await outbox.remove([e.seq]);
  }
  state.pending = await outbox.all();
}

async function pushOps() {
  const ops = state.pending.filter((p) => p.type === 'op');
  if (!ops.length) return;
  const send = async (batch) => api('/api/features', { method: 'POST', body: JSON.stringify({ ops: batch.map((e) => e.op) }) });
  let res = await send(ops);
  if (res.status === 400 && ops.length > 1) {
    // One bad item rejects the batch: send one by one and drop only the invalid ones.
    for (const e of ops) {
      const r = await send([e]);
      if (r.ok || r.status === 400) {
        if (r.status === 400) emit('notice', `נדחה: ${e.op.feature?.name || e.op.id} – ${await errorText(r)}`);
        await outbox.remove([e.seq]);
      } else throw new Error(await errorText(r));
    }
  } else if (res.ok || res.status === 400) {
    if (res.ok) {
      const { results } = await res.json();
      const denied = results.filter((r) => !r.ok);
      denied.forEach((d) => emit('notice', d.error));
    } else emit('notice', `נדחה: ${await errorText(res)}`);
    await outbox.remove(ops.map((e) => e.seq));
  } else {
    throw new Error(await errorText(res));
  }
  state.pending = await outbox.all();
}

async function pull() {
  const res = await api('/api/features', { headers: state.etag ? { 'If-None-Match': state.etag } : {} });
  if (res.status === 304) { state.lastSync = new Date().toISOString(); await persistServer(); return; }
  if (!res.ok) throw new Error(await errorText(res));
  const { features: list, events: evs = [] } = await res.json();
  state.server = new Map(list.map((f) => [f.id, f]));
  state.events = new Map(evs.map((e) => [e.id, e]));
  state.etag = res.headers.get('ETag');
  state.lastSync = new Date().toISOString();
  await persistServer();
}

// ── base layers (OpenStreetMap import) ──
export async function loadBase() {
  const cached = await kv.get('base');
  if (navigator.onLine) {
    try {
      const res = await api('/api/base', { headers: cached?.etag ? { 'If-None-Match': cached.etag } : {} });
      if (res.status === 304) return cached.data;
      if (res.ok) {
        const data = await res.json();
        await kv.set('base', { data, etag: res.headers.get('ETag') });
        return data;
      }
    } catch { /* offline or server error: use the cached copy */ }
  }
  return cached?.data || { type: 'FeatureCollection', features: [] };
}

export async function saveBase(collection) {
  const res = await api('/api/base', { method: 'PUT', body: JSON.stringify(collection) });
  if (!res.ok) throw new Error(await errorText(res));
  await kv.del('base');
  return res.json();
}
