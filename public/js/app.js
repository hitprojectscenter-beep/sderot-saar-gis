// Sderot SA"R GIS — main app: login, map, layers, drawing, data entry, search, export.
import { GROUPS, LAYERS, LAYER_BY_ID, classify, baseGeomType, normalizeText } from './layers.js';
import * as sync from './sync.js';
import { fetchSderotFromOSM, SDEROT_BBOX } from './osm.js';

export const APP_VERSION = '0.1.0';
const SDEROT_CENTER = [31.5245, 34.5965];
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const prefs = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(`saar:${k}`)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`saar:${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
};

let user = null;
let map;
let groups = {}; // layerId → L.FeatureGroup
let allFeatures = [];
let baseFeatures = [];
let visible = new Set(prefs.get('visible', LAYERS.map((l) => l.id)));
let lastPosition = null;

// ───────────────────────── toasts ─────────────────────────
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  if (kind === 'error' && navigator.vibrate) navigator.vibrate([80, 60, 80]);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3200);
}

// ───────────────────────── sheets ─────────────────────────
let openSheetId = null;
function openSheet(id) {
  closeSheet();
  openSheetId = id;
  $(`#${id}`).hidden = false;
  $('#scrim').hidden = false;
}
function closeSheet() {
  if (openSheetId) $(`#${openSheetId}`).hidden = true;
  openSheetId = null;
  $('#scrim').hidden = true;
}
$('#scrim').addEventListener('click', closeSheet);
$$('[data-close]').forEach((b) => b.addEventListener('click', closeSheet));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

// ───────────────────────── theme & text size ─────────────────────────
function applyDisplay() {
  document.body.dataset.theme = prefs.get('theme', 'day');
  document.body.dataset.size = prefs.get('size', 'normal');
  $$('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.themeSet === document.body.dataset.theme));
  $$('[data-size-set]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.sizeSet === document.body.dataset.size));
  document.querySelector('meta[name="theme-color"]').content = { day: '#b71c1c', night: '#161b22', red: '#000000' }[document.body.dataset.theme];
  if (map) {
    setTimeout(() => map.invalidateSize(), 50);
    // The street map and the dark map follow the theme; satellite stays as chosen.
    const current = prefs.get('basemap', 'streets');
    const dark = document.body.dataset.theme !== 'day';
    if (current === 'streets' && dark) setBasemap('dark');
    if (current === 'dark' && !dark) setBasemap('streets');
  }
}
$$('[data-theme-set]').forEach((b) => b.addEventListener('click', () => { prefs.set('theme', b.dataset.themeSet); applyDisplay(); }));
$$('[data-size-set]').forEach((b) => b.addEventListener('click', () => { prefs.set('size', b.dataset.sizeSet); applyDisplay(); }));

// ───────────────────────── login ─────────────────────────
async function start() {
  applyDisplay();
  $('#app-version').textContent = APP_VERSION;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  user = await sync.restoreSession();
  if (user) enterApp();
  else showLogin();
}

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-offline').hidden = navigator.onLine;
  setTimeout(() => $('#login-user').focus(), 50);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter || $('#login-form button');
  btn.disabled = true;
  $('#login-error').textContent = '';
  try {
    user = await sync.login($('#login-user').value.trim(), $('#login-pass').value);
    $('#login-pass').value = '';
    enterApp();
  } catch (err) {
    $('#login-error').textContent = navigator.onLine ? err.message : 'אין חיבור לרשת';
  } finally {
    btn.disabled = false;
  }
});

let appStarted = false;
async function enterApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#user-label').textContent = `${user.label} · ${user.username}`;
  $('#gis-tools').hidden = user.role !== 'gis';
  $('#menu-user').innerHTML = `<strong>${esc(user.label)}</strong><br><span class="muted">${esc(user.username)}</span>`;
  if (appStarted) { map.invalidateSize(); sync.sync(); return; }
  appStarted = true;
  initMap();
  buildLayerList();
  buildLayerSelect();
  sync.on('change', (list) => { allFeatures = list; renderFeatures(); refreshLayerCounts(); });
  sync.on('status', renderStatus);
  sync.on('notice', (msg) => toast(msg, 'error'));
  sync.on('auth', () => { toast('פג תוקף ההתחברות – יש להתחבר מחדש', 'error'); });
  await sync.init();
  baseFeatures = (await sync.loadBase()).features || [];
  renderFeatures();
  refreshLayerCounts();
}

$('#btn-logout').addEventListener('click', async () => {
  const pending = (await import('./db.js')).outbox;
  if ((await pending.count()) > 0 && !confirm('יש נתונים שעדיין לא נשלחו לשרת. לצאת בכל זאת? הנתונים יישמרו במכשיר.')) return;
  await sync.logout();
  closeSheet();
  user = null;
  showLogin();
});

// ───────────────────────── status chip ─────────────────────────
function renderStatus(s) {
  const chip = $('#status');
  chip.className = 'status-chip';
  const pending = s.pending + s.pendingPhotos;
  if (!s.online) { chip.classList.add('offline'); chip.textContent = pending ? `ללא רשת · ${pending} ממתינים` : 'ללא רשת'; }
  else if (s.error) { chip.classList.add('error'); chip.textContent = '⚠ שגיאה'; chip.title = s.error; }
  else if (s.syncing) chip.textContent = 'מסנכרן…';
  else if (pending) { chip.classList.add('offline'); chip.textContent = `${pending} ממתינים`; }
  else { chip.classList.add('ok'); chip.textContent = '✓ מסונכרן'; }
  chip.dataset.detail = [
    s.online ? 'מחובר לרשת' : 'אין חיבור לרשת – הנתונים נשמרים במכשיר',
    pending ? `${s.pending} שינויים ו-${s.pendingPhotos} תמונות ממתינים לשליחה` : 'אין נתונים ממתינים',
    s.lastSync ? `סנכרון אחרון: ${new Date(s.lastSync).toLocaleTimeString('he-IL')}` : '',
    s.error || '',
  ].filter(Boolean).join('\n');
}
$('#status').addEventListener('click', (e) => { toast(e.currentTarget.dataset.detail || ''); sync.sync(); });
$('#btn-sync-now').addEventListener('click', () => { sync.sync(); toast('מסנכרן…'); });

// ───────────────────────── map ─────────────────────────
const BASEMAPS = {
  streets: { name: 'רחובות', url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', attr: '© OpenStreetMap contributors © CARTO', sub: 'abcd', max: 20 },
  satellite: { name: 'תצלום', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attr: 'Esri, Maxar, Earthstar Geographics', max: 19 },
  osm: { name: 'OSM', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '© OpenStreetMap contributors', max: 19 },
  dark: { name: 'כהה', url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', attr: '© OpenStreetMap contributors © CARTO', sub: 'abcd', max: 20 },
};
let baseLayer;
function setBasemap(id, remember = true) {
  const b = BASEMAPS[id] || BASEMAPS.streets;
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = L.tileLayer(b.url, { attribution: b.attr, subdomains: b.sub || 'abc', maxZoom: 21, maxNativeZoom: b.max, crossOrigin: true }).addTo(map);
  if (remember) prefs.set('basemap', id);
  $$('#basemaps .btn').forEach((btn) => btn.setAttribute('aria-pressed', btn.dataset.base === id));
}

function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true, tap: true }).setView(prefs.get('view', { c: SDEROT_CENTER, z: 15 }).c, prefs.get('view', { z: 15 }).z);
  L.control.zoom({ position: 'topleft' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);
  $('#basemaps').innerHTML = Object.entries(BASEMAPS).map(([id, b]) => `<button class="btn" type="button" data-base="${id}" role="radio">${b.name}</button>`).join('');
  $$('#basemaps .btn').forEach((btn) => btn.addEventListener('click', () => setBasemap(btn.dataset.base)));
  setBasemap(prefs.get('basemap', document.body.dataset.theme === 'day' ? 'streets' : 'dark'));
  map.on('moveend', () => prefs.set('view', { c: [map.getCenter().lat, map.getCenter().lng], z: map.getZoom() }));
  map.on('zoomend', updateStreetLabels);
  map.on('dragstart', () => { followGps = false; $('#btn-locate').classList.remove('active'); });

  // Order matters: areas under lines under points.
  map.createPane('areas').style.zIndex = 410;
  map.createPane('lines').style.zIndex = 420;
  for (const l of LAYERS) groups[l.id] = L.featureGroup();
  applyVisibility();

  map.pm.setLang('he', {
    tooltips: {
      placeMarker: 'הקישו למיקום הנקודה',
      firstVertex: 'הקישו לנקודה הראשונה',
      continueLine: 'הקישו להמשך',
      finishLine: 'הקישו על הנקודה האחרונה או „סיום”',
      finishPoly: 'הקישו על הנקודה הראשונה או „סיום”',
    },
  }, 'en');
  map.pm.setGlobalOptions({ snappable: false, tooltips: true, templineStyle: { color: '#c62828', weight: 4 }, hintlineStyle: { color: '#c62828', dashArray: '6,6' }, pathOptions: { color: '#c62828', weight: 4 } });
  map.on('pm:create', onDrawCreated);

  map.on('locationfound', onLocation);
  map.on('locationerror', () => toast('לא ניתן לקבל מיקום GPS', 'error'));
  map.locate({ watch: true, enableHighAccuracy: true, setView: false });
}

// ───────────────────────── GPS ─────────────────────────
let gpsMarker, gpsCircle;
function onLocation(e) {
  lastPosition = e;
  if (!gpsMarker) {
    gpsMarker = L.marker(e.latlng, { icon: L.divIcon({ className: '', html: '<div class="gps-dot"></div>', iconSize: [20, 20] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
    gpsCircle = L.circle(e.latlng, { radius: e.accuracy, weight: 1, color: '#1e88e5', fillOpacity: 0.08, interactive: false }).addTo(map);
  } else {
    gpsMarker.setLatLng(e.latlng);
    gpsCircle.setLatLng(e.latlng).setRadius(e.accuracy);
  }
  if (followGps) map.setView(e.latlng, Math.max(map.getZoom(), 17));
}
let followGps = false;
$('#btn-locate').addEventListener('click', () => {
  followGps = !followGps;
  $('#btn-locate').classList.toggle('active', followGps);
  if (lastPosition) map.setView(lastPosition.latlng, Math.max(map.getZoom(), 17));
  else { map.locate({ watch: true, enableHighAccuracy: true }); toast('מחפש מיקום GPS…'); }
});

// ───────────────────────── rendering ─────────────────────────
function markerIcon(layer, { pending = false, base = false } = {}) {
  const size = base ? 26 : 38;
  return L.divIcon({
    className: '',
    html: `<div class="marker-pin ${pending ? 'pending' : ''} ${base ? 'base' : ''}" style="background:${layer.color}"><span>${layer.icon}</span></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
  });
}

function toLeaflet(geometry, layer, { pending = false, base = false, onClick }) {
  const type = baseGeomType(geometry.type);
  let lyr;
  if (type === 'Point') {
    const [lon, lat] = geometry.coordinates;
    lyr = L.marker([lat, lon], { icon: markerIcon(layer, { pending, base }), riseOnHover: true });
  } else {
    const style = {
      pane: type === 'Polygon' ? 'areas' : 'lines',
      color: layer.color,
      weight: type === 'Polygon' ? 3 : (base ? 4 : 6),
      opacity: base ? 0.7 : 0.95,
      fillOpacity: base ? 0.08 : 0.22,
      dashArray: pending ? '8,6' : (base && type === 'Polygon' ? '4,6' : null),
    };
    lyr = L.geoJSON({ type: 'Feature', geometry }, { style: () => style });
  }
  if (onClick) lyr.on('click', (e) => { L.DomEvent.stopPropagation(e); onClick(); });
  return lyr;
}

let streetLabelLayers = [];
function renderFeatures() {
  if (!map) return;
  Object.values(groups).forEach((g) => g.clearLayers());
  streetLabelLayers = [];
  for (const f of baseFeatures) {
    const layer = LAYER_BY_ID[f.properties.layer];
    if (!layer || !f.geometry) continue;
    const lyr = toLeaflet(f.geometry, layer, { base: true, onClick: () => showBaseDetail(f) });
    if (f.properties.layer === 'streets' && f.properties.name) {
      lyr.bindTooltip(f.properties.name, { permanent: true, direction: 'center', className: 'street-label', opacity: 0.9 });
      streetLabelLayers.push(lyr);
    }
    groups[layer.id].addLayer(lyr);
  }
  for (const f of allFeatures) {
    const layer = LAYER_BY_ID[f.layer] || LAYER_BY_ID.general_point;
    if (!f.geometry) continue;
    groups[layer.id].addLayer(toLeaflet(f.geometry, layer, { pending: f.pending, onClick: () => showDetail(f.id) }));
  }
  updateStreetLabels();
  if (openDetailId) showDetail(openDetailId, true);
}

function updateStreetLabels() {
  // Street names only when zoomed in, so they don't bury the map.
  const show = map.getZoom() >= 17;
  for (const l of streetLabelLayers) { if (show) l.openTooltip?.(); else l.closeTooltip?.(); }
}

function applyVisibility() {
  for (const l of LAYERS) {
    if (visible.has(l.id)) groups[l.id].addTo(map);
    else map.removeLayer(groups[l.id]);
  }
  prefs.set('visible', [...visible]);
}

// ───────────────────────── layer panel ─────────────────────────
function buildLayerList() {
  $('#layer-list').innerHTML = GROUPS.map((g) => {
    const layers = LAYERS.filter((l) => l.group === g.id);
    return `<div class="layer-group"><div class="layer-group-head"><span>${g.name}</span>
      <button class="icon-btn" type="button" data-group-toggle="${g.id}" aria-label="הצג/הסתר קבוצה">◐</button></div>
      ${layers.map((l) => `<label class="layer-row"><input type="checkbox" data-layer="${l.id}" ${visible.has(l.id) ? 'checked' : ''}>
        <span class="swatch" style="border-color:${l.color}">${l.icon}</span><span class="name">${l.name}</span><span class="count" data-count="${l.id}"></span></label>`).join('')}</div>`;
  }).join('');
  $$('#layer-list input[data-layer]').forEach((cb) => cb.addEventListener('change', () => {
    cb.checked ? visible.add(cb.dataset.layer) : visible.delete(cb.dataset.layer);
    applyVisibility();
  }));
  $$('[data-group-toggle]').forEach((b) => b.addEventListener('click', () => {
    const ids = LAYERS.filter((l) => l.group === b.dataset.groupToggle).map((l) => l.id);
    const allOn = ids.every((id) => visible.has(id));
    ids.forEach((id) => (allOn ? visible.delete(id) : visible.add(id)));
    syncLayerChecks();
  }));
}
function syncLayerChecks() {
  $$('#layer-list input[data-layer]').forEach((cb) => { cb.checked = visible.has(cb.dataset.layer); });
  applyVisibility();
}
$('#layers-all').addEventListener('click', () => { visible = new Set(LAYERS.map((l) => l.id)); syncLayerChecks(); });
$('#layers-none').addEventListener('click', () => { visible = new Set(); syncLayerChecks(); });
$('#layers-event').addEventListener('click', () => {
  // Event mode: what a commander needs in the first hours — the live event plus rescue resources.
  visible = new Set(LAYERS.filter((l) => ['event', 'medical', 'protection', 'unit', 'fire', 'infra', 'population'].includes(l.group) || l.id === 'sectors' || l.id === 'risk_buildings').map((l) => l.id));
  syncLayerChecks();
  toast('מצב אירוע: שכבות האירוע, המיגון, ההצלה והתשתיות');
});
$('#btn-layers').addEventListener('click', () => openSheet('sheet-layers'));

function refreshLayerCounts() {
  const counts = {};
  for (const f of allFeatures) counts[f.layer] = (counts[f.layer] || 0) + 1;
  for (const f of baseFeatures) counts[f.properties.layer] = (counts[f.properties.layer] || 0) + 1;
  $$('[data-count]').forEach((el) => { el.textContent = counts[el.dataset.count] || ''; });
}

// ───────────────────────── drawing ─────────────────────────
let drawing = null; // { shape } while drawing a new item, { featureId, layer } while editing a shape
const DRAW_HINTS = {
  Marker: 'הקישו על המפה במיקום הנקודה',
  Line: 'הקישו נקודה אחר נקודה לאורך הקו, ואז „סיום”',
  Polygon: 'הקישו את פינות השטח, ואז „סיום”',
};
function setDrawMode(on, hint = '') {
  $('#actions').hidden = on;
  $('#drawbar').hidden = !on;
  $('#draw-hint').textContent = hint;
  $('#draw-undo').hidden = !on || drawing?.shape === 'Marker' || !!drawing?.featureId;
  $('#draw-finish').hidden = drawing?.shape === 'Marker';
}

$$('[data-draw]').forEach((b) => b.addEventListener('click', () => startDraw(b.dataset.draw)));
function startDraw(shape) {
  closeSheet();
  drawing = { shape };
  map.pm.enableDraw(shape, { continueDrawing: false, finishOn: null, markerStyle: { icon: markerIcon(LAYER_BY_ID.general_point) } });
  setDrawMode(true, DRAW_HINTS[shape]);
}
$('#draw-cancel').addEventListener('click', cancelDraw);
function cancelDraw() {
  map.pm.disableDraw();
  if (drawing?.layer) { drawing.layer.pm.disable(); map.removeLayer(drawing.layer); }
  drawing = null;
  setDrawMode(false);
}
$('#draw-undo').addEventListener('click', () => {
  const d = map.pm.Draw[drawing?.shape];
  if (d?._removeLastVertex) d._removeLastVertex();
});
$('#draw-finish').addEventListener('click', () => {
  if (drawing?.featureId) return finishShapeEdit();
  const d = map.pm.Draw[drawing?.shape];
  if (d?._finishShape) d._finishShape();
});

function onDrawCreated(e) {
  const geometry = e.layer.toGeoJSON().geometry;
  map.removeLayer(e.layer);
  map.pm.disableDraw();
  drawing = null;
  setDrawMode(false);
  openForm({ geometry });
}

$('#btn-here').addEventListener('click', () => {
  if (!lastPosition) { toast('ממתין למיקום GPS… נסו שוב בעוד רגע', 'error'); map.locate({ watch: true, enableHighAccuracy: true }); return; }
  const { lat, lng } = lastPosition.latlng;
  if (lastPosition.accuracy > 50) toast(`דיוק GPS נמוך (±${Math.round(lastPosition.accuracy)} מ׳)`);
  openForm({ geometry: { type: 'Point', coordinates: [lng, lat] } });
});

// ───────────────────────── form ─────────────────────────
let form = null; // { feature, photos, manualLayer }
function buildLayerSelect() {
  $('#f-layer').innerHTML = GROUPS.map((g) => `<optgroup label="${g.name}">${LAYERS.filter((l) => l.group === g.id).map((l) => `<option value="${l.id}">${l.icon} ${l.name}</option>`).join('')}</optgroup>`).join('');
}

function openForm({ geometry, feature }) {
  const f = feature ? structuredClone(feature) : { id: sync.uuid(), geometry, name: '', description: '', photos: [], layer: null };
  form = { feature: f, photos: [...(f.photos || [])], manualLayer: !!feature };
  $('#form-title').textContent = feature ? 'עריכת נתון' : `נתון חדש · ${{ Point: 'נקודה', LineString: 'קו', Polygon: 'שטח' }[baseGeomType(f.geometry.type)]}`;
  $('#f-name').value = f.name;
  $('#f-desc').value = f.description;
  $('#f-meta').textContent = feature ? `נוצר ע״י ${f.createdBy?.label || ''} (${f.createdBy?.username || ''})` : `יירשם כמעדכן: ${user.label} (${user.username})`;
  // Only layers that accept this geometry can be chosen.
  const geom = baseGeomType(f.geometry.type);
  $$('#f-layer option').forEach((o) => { o.disabled = !LAYER_BY_ID[o.value].geom.includes(geom); });
  if (feature) $('#f-layer').value = f.layer;
  updateLayerSuggestion();
  renderThumbs();
  openSheet('sheet-form');
  setTimeout(() => $('#f-name').focus(), 80);
}

function updateLayerSuggestion() {
  if (!form) return;
  const hint = $('#f-layer-hint');
  const geomType = form.feature.geometry.type;
  const s = classify({ name: $('#f-name').value, description: $('#f-desc').value, geometryType: geomType });
  if (form.manualLayer) {
    const l = LAYER_BY_ID[$('#f-layer').value];
    hint.className = 'layer-hint manual';
    hint.innerHTML = `נבחר ידנית: <b>${l.icon} ${l.name}</b> <button type="button" id="f-auto">זיהוי אוטומטי</button>`;
    $('#f-auto').onclick = () => { form.manualLayer = false; updateLayerSuggestion(); };
    return;
  }
  $('#f-layer').value = s.layerId;
  const l = LAYER_BY_ID[s.layerId];
  hint.className = 'layer-hint auto';
  if (s.confident) hint.innerHTML = `זוהה אוטומטית: <b>${l.icon} ${l.name}</b> <span class="muted">(לפי „${esc(s.keyword)}”)</span>`;
  else if (s.hintLayerId) hint.innerHTML = `<b>${l.icon} ${l.name}</b> <span class="muted">– „${esc(s.keyword)}” מתאים ל${LAYER_BY_ID[s.hintLayerId].name}, אך לא לסוג גאומטריה זה</span>`;
  else hint.innerHTML = `<b>${l.icon} ${l.name}</b> <span class="muted">– הקלידו שם (למשל „מקלט”, „ברז כיבוי”) והשכבה תזוהה</span>`;
}
$('#f-name').addEventListener('input', updateLayerSuggestion);
$('#f-desc').addEventListener('input', updateLayerSuggestion);
$('#f-layer').addEventListener('change', () => { form.manualLayer = true; updateLayerSuggestion(); });

async function renderThumbs() {
  const box = $('#f-photos');
  box.innerHTML = '';
  for (const id of form.photos) {
    const div = document.createElement('div');
    div.className = 'thumb';
    div.innerHTML = `<img alt="תמונה"><button type="button" aria-label="הסרת תמונה">✕</button>`;
    div.querySelector('img').src = await sync.photoUrl(id);
    div.querySelector('img').onclick = (e) => openLightbox(e.target.src);
    div.querySelector('button').onclick = () => { form.photos = form.photos.filter((p) => p !== id); renderThumbs(); };
    box.append(div);
  }
}

$('#f-photo-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const file of files) {
    try {
      const dataUrl = await compressImage(file);
      form.photos.push(await sync.addPhoto(dataUrl));
    } catch (err) {
      toast(`לא ניתן לטעון תמונה: ${err.message}`, 'error');
    }
  }
  renderThumbs();
});

/** Resize to max 1600 px and re-encode as JPEG so uploads stay small on a weak network. */
async function compressImage(file, max = 1600, quality = 0.72) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  const src = bitmap || await new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error('פורמט לא נתמך')); img.src = URL.createObjectURL(file); });
  const scale = Math.min(1, max / Math.max(src.width, src.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(src.width * scale);
  canvas.height = Math.round(src.height * scale);
  canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

$('#feature-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#f-name').value.trim();
  if (!name) { $('#f-name').focus(); return; }
  const f = { ...form.feature, name, description: $('#f-desc').value.trim(), photos: form.photos, layer: $('#f-layer').value };
  delete f.pending;
  await sync.saveFeature(f, user);
  const l = LAYER_BY_ID[f.layer];
  toast(`נשמר בשכבת „${l.name}”${navigator.onLine ? '' : ' – יישלח כשתחזור הרשת'}`, 'ok');
  if (navigator.vibrate) navigator.vibrate(60);
  if (!visible.has(f.layer)) { visible.add(f.layer); syncLayerChecks(); }
  form = null;
  closeSheet();
});

// Voice dictation (where the browser supports Hebrew speech recognition): useful with gloves on.
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Speech) {
  const mic = $('#f-mic');
  mic.hidden = false;
  let rec = null;
  mic.addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    rec = new Speech();
    rec.lang = 'he-IL';
    rec.interimResults = false;
    rec.onresult = (ev) => {
      const text = [...ev.results].map((r) => r[0].transcript).join(' ');
      const ta = $('#f-desc');
      ta.value = `${ta.value} ${text}`.trim();
      updateLayerSuggestion();
    };
    rec.onend = () => { mic.classList.remove('listening'); rec = null; };
    rec.onerror = () => toast('ההכתבה הקולית לא זמינה כרגע', 'error');
    mic.classList.add('listening');
    rec.start();
  });
}

// ───────────────────────── details ─────────────────────────
let openDetailId = null;
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '');
function centroid(geometry) {
  const pts = [];
  const walk = (c) => (typeof c[0] === 'number' ? pts.push(c) : c.forEach(walk));
  walk(geometry.coordinates);
  const lon = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const lat = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  return [lat, lon];
}
function canDelete(f) { return ['gis', 'commander', 'deputy'].includes(user.role) || f.createdBy?.username === user.username; }

async function showDetail(id, refresh = false) {
  const f = sync.getFeature(id);
  if (!f) { if (openDetailId === id) { openDetailId = null; if (openSheetId === 'sheet-detail') closeSheet(); } return; }
  if (refresh && openSheetId !== 'sheet-detail') return;
  openDetailId = id;
  const l = LAYER_BY_ID[f.layer] || LAYER_BY_ID.general_point;
  const [lat, lon] = centroid(f.geometry);
  $('#d-title').textContent = f.name;
  $('#d-body').innerHTML = `
    <span class="detail-layer" style="border-color:${l.color}">${l.icon} ${l.name}</span>
    ${f.pending ? '<span class="pending-badge">ממתין לשליחה</span>' : ''}
    ${f.description ? `<div class="detail-desc">${esc(f.description)}</div>` : ''}
    <div class="thumbs" id="d-photos"></div>
    <table class="meta-table">
      <tr><th>נוצר ע״י</th><td>${esc(f.createdBy?.label)} · ${esc(f.createdBy?.username)}<br><span class="muted">${fmt(f.createdAt)}</span></td></tr>
      <tr><th>עודכן לאחרונה ע״י</th><td>${esc(f.updatedBy?.label)} · ${esc(f.updatedBy?.username)}<br><span class="muted">${fmt(f.updatedAt)}</span></td></tr>
      <tr><th>מיקום</th><td dir="ltr" style="text-align:right">${lat.toFixed(6)}, ${lon.toFixed(6)}</td></tr>
    </table>
    ${f.history?.length ? `<details class="history"><summary>היסטוריית עדכונים (${f.history.length})</summary><ul>${[...f.history].reverse().map((h) => `<li>${esc(h.action)} · ${esc(h.by?.label)} (${esc(h.by?.username)}) · ${fmt(h.at)}</li>`).join('')}</ul></details>` : ''}
    <div class="detail-actions">
      <button class="btn" id="d-edit" type="button">✏️ עריכת פרטים</button>
      <button class="btn" id="d-shape" type="button">📐 עריכת צורה</button>
      <a class="btn" href="https://waze.com/ul?ll=${lat},${lon}&navigate=yes" target="_blank" rel="noopener">🚗 ניווט</a>
      <button class="btn" id="d-zoom" type="button">🔎 התמקד</button>
      ${canDelete(f) ? '<button class="btn btn-danger" id="d-delete" type="button">🗑 מחיקה</button>' : ''}
    </div>`;
  const box = $('#d-photos');
  for (const pid of f.photos || []) {
    const div = document.createElement('div');
    div.className = 'thumb';
    const img = document.createElement('img');
    img.alt = 'תמונה';
    img.src = await sync.photoUrl(pid);
    img.onclick = () => openLightbox(img.src);
    div.append(img);
    box.append(div);
  }
  $('#d-edit').onclick = () => openForm({ feature: f });
  $('#d-shape').onclick = () => startShapeEdit(f);
  $('#d-zoom').onclick = () => { zoomTo(f.geometry); closeSheet(); };
  const del = $('#d-delete');
  if (del) del.onclick = async () => {
    if (!confirm(`למחוק את „${f.name}”?`)) return;
    await sync.deleteFeature(f.id);
    toast('נמחק', 'ok');
    closeSheet();
  };
  if (!refresh) openSheet('sheet-detail');
}

function showBaseDetail(f) {
  openDetailId = null;
  const p = f.properties;
  const l = LAYER_BY_ID[p.layer];
  const [lat, lon] = centroid(f.geometry);
  $('#d-title').textContent = p.name || l.name;
  const extra = ['addr:street', 'addr:housenumber', 'capacity', 'operator', 'opening_hours', 'phone', 'description', 'note'].filter((k) => p[k]).map((k) => `<tr><th>${k}</th><td>${esc(p[k])}</td></tr>`).join('');
  $('#d-body').innerHTML = `
    <span class="detail-layer" style="border-color:${l.color}">${l.icon} ${l.name}</span>
    <p class="muted small">שכבת בסיס · מקור: OpenStreetMap${p.osm ? ` (${esc(p.osm)})` : ''} · לקריאה בלבד</p>
    <table class="meta-table">${extra}<tr><th>מיקום</th><td dir="ltr" style="text-align:right">${lat.toFixed(6)}, ${lon.toFixed(6)}</td></tr></table>
    <div class="detail-actions">
      <a class="btn" href="https://waze.com/ul?ll=${lat},${lon}&navigate=yes" target="_blank" rel="noopener">🚗 ניווט</a>
      <button class="btn" id="d-copy" type="button">📋 העתקה כנתון לעריכה</button>
    </div>`;
  $('#d-copy').onclick = () => {
    const g = f.geometry.type.startsWith('Multi') ? null : f.geometry;
    if (!g) { toast('לא ניתן להעתיק גאומטריה מרובת חלקים', 'error'); return; }
    openForm({ geometry: g });
    $('#f-name').value = p.name || '';
    form.manualLayer = true;
    $('#f-layer').value = p.layer;
    updateLayerSuggestion();
  };
  openSheet('sheet-detail');
}

function zoomTo(geometry) {
  if (geometry.type === 'Point') map.setView([geometry.coordinates[1], geometry.coordinates[0]], Math.max(map.getZoom(), 18));
  else map.fitBounds(L.geoJSON(geometry).getBounds(), { maxZoom: 19, padding: [40, 40] });
}

function startShapeEdit(f) {
  closeSheet();
  const layer = L.geoJSON(f.geometry, { pointToLayer: (_, ll) => L.marker(ll, { draggable: true }) }).getLayers()[0];
  layer.addTo(map);
  if (layer.pm) layer.pm.enable({ draggable: true, allowSelfIntersection: false });
  if (layer.dragging) layer.dragging.enable();
  drawing = { featureId: f.id, layer };
  setDrawMode(true, f.geometry.type === 'Point' ? 'גררו את הנקודה למיקום החדש' : 'גררו את הקודקודים, ואז „סיום”');
  $('#draw-finish').hidden = false;
  zoomTo(f.geometry);
}

async function finishShapeEdit() {
  const { featureId, layer } = drawing;
  const geometry = layer.toGeoJSON().geometry;
  layer.pm?.disable();
  map.removeLayer(layer);
  drawing = null;
  setDrawMode(false);
  const f = sync.getFeature(featureId);
  if (!f) return;
  const updated = { ...f, geometry };
  delete updated.pending;
  await sync.saveFeature(updated, user);
  toast('הצורה עודכנה', 'ok');
}

// ───────────────────────── lightbox ─────────────────────────
function openLightbox(src) {
  const lb = $('#lightbox');
  lb.querySelector('img').src = src;
  lb.hidden = false;
}
$('#lightbox').addEventListener('click', () => { $('#lightbox').hidden = true; });

// ───────────────────────── search ─────────────────────────
$('#btn-search').addEventListener('click', () => { openSheet('sheet-search'); setTimeout(() => $('#search-input').focus(), 80); });
$('#search-input').addEventListener('input', () => {
  const q = normalizeText($('#search-input').value).trim();
  const out = $('#search-results');
  if (q.length < 2) { out.innerHTML = ''; return; }
  const words = q.split(' ');
  const match = (text) => { const t = normalizeText(text); return words.every((w) => t.includes(w)); };
  const hits = [
    ...allFeatures.filter((f) => match(`${f.name} ${f.description} ${LAYER_BY_ID[f.layer]?.name}`)).map((f) => ({ kind: 'f', f, name: f.name, layer: f.layer })),
    ...baseFeatures.filter((f) => match(`${f.properties.name} ${LAYER_BY_ID[f.properties.layer]?.name}`)).map((f) => ({ kind: 'b', f, name: f.properties.name, layer: f.properties.layer })),
  ].slice(0, 60);
  out.innerHTML = hits.length ? hits.map((h, i) => `<li><button type="button" data-hit="${i}"><span>${LAYER_BY_ID[h.layer]?.icon || '📍'}</span><span>${esc(h.name)}<small>${LAYER_BY_ID[h.layer]?.name || ''}${h.kind === 'b' ? ' · שכבת בסיס' : ''}</small></span></button></li>`).join('') : '<li class="muted">לא נמצאו תוצאות</li>';
  $$('[data-hit]').forEach((b) => b.addEventListener('click', () => {
    const h = hits[Number(b.dataset.hit)];
    if (!visible.has(h.layer)) { visible.add(h.layer); syncLayerChecks(); }
    zoomTo(h.f.geometry);
    if (h.kind === 'f') showDetail(h.f.id); else showBaseDetail(h.f);
  }));
});

// ───────────────────────── menu & tools ─────────────────────────
$('#btn-menu').addEventListener('click', () => openSheet('sheet-menu'));

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

$('#btn-export-geojson').addEventListener('click', () => {
  const fc = { type: 'FeatureCollection', features: allFeatures.map((f) => ({ type: 'Feature', id: f.id, geometry: f.geometry, properties: {
    layer: f.layer, layer_name: LAYER_BY_ID[f.layer]?.name, name: f.name, description: f.description, photos: f.photos?.length || 0,
    created_by: f.createdBy?.username, created_at: f.createdAt, updated_by: f.updatedBy?.username, updated_at: f.updatedAt } })) };
  download(`saar-sderot-${stamp()}.geojson`, JSON.stringify(fc, null, 1), 'application/geo+json');
});

$('#btn-export-xlsx').addEventListener('click', () => {
  const cols = ['מזהה', 'שכבה', 'שם', 'תיאור', 'סוג', 'קו רוחב', 'קו אורך', 'תמונות', 'נוצר ע״י', 'נוצר בתאריך', 'עודכן ע״י', 'עודכן בתאריך'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = allFeatures.map((f) => {
    const [lat, lon] = centroid(f.geometry);
    return [f.id, LAYER_BY_ID[f.layer]?.name, f.name, f.description, { Point: 'נקודה', LineString: 'קו', Polygon: 'שטח' }[baseGeomType(f.geometry.type)],
      lat.toFixed(6), lon.toFixed(6), f.photos?.length || 0, f.createdBy?.label, fmt(f.createdAt), f.updatedBy?.label, fmt(f.updatedAt)].map(cell).join(',');
  });
  // BOM so Excel opens Hebrew correctly.
  download(`saar-sderot-${stamp()}.csv`, `﻿${cols.map(cell).join(',')}\r\n${rows.join('\r\n')}`, 'text/csv;charset=utf-8');
});

// Offline map: fetch the tiles covering Sderot so the service worker stores them.
function tilesFor([s, w, n, e], z) {
  const x = (lon) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const y = (lat) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
  const out = [];
  for (let tx = x(w); tx <= x(e); tx++) for (let ty = y(n); ty <= y(s); ty++) out.push({ x: tx, y: ty, z });
  return out;
}
$('#btn-offline-tiles').addEventListener('click', async () => {
  if (!navigator.onLine) { toast('נדרש חיבור לרשת להורדה', 'error'); return; }
  const id = prefs.get('basemap', 'streets');
  const b = BASEMAPS[id];
  const tiles = [13, 14, 15, 16, 17].flatMap((z) => tilesFor(SDEROT_BBOX, z));
  const urls = tiles.map((t) => b.url.replace('{s}', 'abcd'[(t.x + t.y) % 4]).replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y).replace('{r}', ''));
  let done = 0; let failed = 0;
  const progress = $('#offline-progress');
  const worker = async () => {
    while (urls.length) {
      const u = urls.shift();
      try { await fetch(u, { mode: 'cors' }); } catch { failed++; }
      done++;
      if (done % 10 === 0) progress.textContent = `הורדו ${done} מתוך ${tiles.length} אריחים (${b.name})…`;
    }
  };
  progress.textContent = `מוריד ${tiles.length} אריחים…`;
  await Promise.all(Array.from({ length: 6 }, worker));
  progress.textContent = `מפת „${b.name}” של שדרות נשמרה במכשיר (${done - failed} אריחים, זום 13–17).`;
  toast('המפה נשמרה לשימוש ללא רשת', 'ok');
});

// GIS officer: import base layers.
$('#btn-osm-import').addEventListener('click', async () => {
  if (!confirm('לייבא מחדש את שכבות הבסיס (רחובות, שכונות, ברזי כיבוי, דפיברילטורים, מקלטים, מוסדות) מ-OpenStreetMap? הייבוא יחליף את שכבות הבסיס הקיימות.')) return;
  const status = $('#osm-status');
  try {
    const fc = await fetchSderotFromOSM((m) => { status.textContent = m; });
    status.textContent = `התקבלו ${fc.features.length} פריטים. שומר בשרת…`;
    const r = await sync.saveBase(fc);
    baseFeatures = (await sync.loadBase()).features || [];
    renderFeatures(); refreshLayerCounts();
    status.textContent = `נשמרו ${r.count} פריטי בסיס.`;
    toast('שכבות הבסיס עודכנו', 'ok');
  } catch (e) {
    status.textContent = e.message;
    toast(e.message, 'error');
  }
});
$('#base-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const fc = JSON.parse(await file.text());
    if (fc.type !== 'FeatureCollection') throw new Error('הקובץ אינו GeoJSON FeatureCollection');
    // Each feature needs properties.layer; classify the ones without it by name.
    fc.features = fc.features.filter((f) => f.geometry).map((f) => {
      const p = f.properties || {};
      const name = p.name || p.NAME || p['שם'] || '';
      const layer = LAYER_BY_ID[p.layer] ? p.layer : classify({ name, description: p.description || '', geometryType: f.geometry.type }).layerId;
      return { type: 'Feature', geometry: f.geometry, properties: { ...p, name, layer } };
    });
    const existing = await sync.loadBase();
    const merged = { type: 'FeatureCollection', features: [...(existing.features || []), ...fc.features], source: `${existing.source || ''} + ${file.name}` };
    const r = await sync.saveBase(merged);
    baseFeatures = (await sync.loadBase()).features || [];
    renderFeatures(); refreshLayerCounts();
    toast(`נוספו ${fc.features.length} פריטים לשכבות הבסיס (סה״כ ${r.count})`, 'ok');
  } catch (err) {
    toast(`ייבוא נכשל: ${err.message}`, 'error');
  }
});

// Scanned city map (reference only; not georeferenced).
let scanMap;
$('#btn-scan').addEventListener('click', () => {
  closeSheet();
  $('#scan-viewer').hidden = false;
  if (!scanMap) {
    const W = 2244; const H = 3000;
    scanMap = L.map('scan-map', { crs: L.CRS.Simple, minZoom: -3, maxZoom: 2, zoomSnap: 0.25, attributionControl: false });
    const bounds = [[0, 0], [H, W]];
    L.imageOverlay('/img/sderot-map.jpg', bounds).addTo(scanMap);
    scanMap.fitBounds(bounds);
  } else scanMap.invalidateSize();
});
$('#scan-close').addEventListener('click', () => { $('#scan-viewer').hidden = true; });

start();
