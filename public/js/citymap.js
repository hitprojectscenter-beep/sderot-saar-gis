// "City map" basemap: draws Sderot from OpenStreetMap data in the style of the municipal paper map
// (urban area in light grey, parks green, industry purple, public-institution plots tan; residential
// buildings yellow, public blue, commercial pink, industrial purple; white streets with their names
// written along them, road-number badges, railway, neighborhood names, legend-like symbols).
import { kv } from './db.js';

export const COLORS = {
  outside: '#cfe3b4',
  urban: '#e9e3ea',
  boundary: '#7a7a7a',
  landuse: {
    residential: '#e9e3ea', park: '#58b947', sport: '#93cf7c', open: '#cfe3b4', industrial: '#cdb8e6',
    commercial: '#f3c9de', institution: '#ddb06a', cemetery: '#b9cbb0', planned: '#f5dcea', water: '#8fcaf3', parking: '#dcdcdc',
  },
  building: {
    residential: ['#f2b33d', '#a8740d'], public: ['#4d93e6', '#1f5fa8'], commercial: ['#e65fa3', '#a3306a'], industrial: ['#9372cc', '#5b3f94'],
  },
};

const POI_ICONS = {
  police: '🚓', fire: '🚒', ambulance: '🚑', clinic: '🏥', pharmacy: '💊', townhall: '🏛', school: '🏫', kindergarten: '🧸',
  synagogue: '✡️', mikveh: '💧', community: '🏠', library: '📚', bank: '🏦', post: '📮', fuel: '⛽', shopping: '🛒', sport: '🏟',
  pool: '🏊', playground: '🛝', fitness: '🏋', cemetery: '⚰️', memorial: '🎗', train: '🚆', bus: '🚌', elderly: '👴', attraction: '⭐',
};
export const POI_NAMES = {
  police: 'משטרה', fire: 'כבאות והצלה', ambulance: 'מד״א', clinic: 'קופת חולים / מרפאה', pharmacy: 'בית מרקחת', townhall: 'עירייה / משרדים',
  school: 'בית ספר', kindergarten: 'גן ילדים / מעון', synagogue: 'בית כנסת', mikveh: 'מקווה', community: 'מתנ״ס / מועדון', library: 'ספרייה',
  bank: 'בנק', post: 'דואר', fuel: 'תחנת דלק', shopping: 'מרכז קניות', sport: 'מתקן ספורט', pool: 'בריכת שחייה', playground: 'גן משחקים',
  fitness: 'מתקני כושר', cemetery: 'בית עלמין', memorial: 'אנדרטה', train: 'תחנת רכבת', bus: 'תחנה מרכזית', elderly: 'מרכז יום לקשיש', attraction: 'אטרקציה',
};

// Road width in meters per class: drawn to scale, like a printed city map.
const ROADS = {
  major: { m: 20, min: 3, fill: '#ffd84d', casing: '#b98f00' },
  primary: { m: 15, min: 3, fill: '#ffffff', casing: '#666666' },
  secondary: { m: 12, min: 2.5, fill: '#ffffff', casing: '#777777' },
  street: { m: 8, min: 2, fill: '#ffffff', casing: '#8a8a8a' },
  service: { m: 5, min: 1, fill: '#ffffff', casing: '#9a9a9a' },
  planned: { m: 8, min: 2, fill: '#f39bc8', casing: '#f39bc8', dash: '6,6' },
  path: { m: 2.5, min: 1, fill: '#ffffff', casing: '#b48a5a', dash: '4,4' },
};
const ROAD_ORDER = ['path', 'service', 'planned', 'street', 'secondary', 'primary', 'major'];

let data = null; // { manifest, parts: { landuse, buildings, … } }
let map;
let group; // everything of the city map
let roadLayers = {};
let labelLayer;
let streetCandidates = [];
let refCandidates = [];
let active = false;

// ───────── loading (cached for offline use) ─────────
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Returns true when city map data is available (from the server or the offline cache). */
export async function loadCityData() {
  const cached = await kv.get('city');
  if (navigator.onLine) {
    try {
      const manifest = await fetchJson('/api/city?f=manifest');
      if (manifest.missing) return !!(data = cached || null);
      if (cached && cached.manifest.importedAt === manifest.importedAt) { data = cached; return true; }
      const parts = {};
      for (const [name, chunks] of Object.entries(manifest.parts)) {
        const fcs = await Promise.all(chunks.map((c) => fetchJson(`/api/city?f=${c}`)));
        parts[name] = { type: 'FeatureCollection', features: fcs.flatMap((fc) => fc.features) };
      }
      data = { manifest, parts };
      await kv.set('city', data);
      return true;
    } catch {
      /* fall through to the cached copy */
    }
  }
  data = cached || null;
  return !!data;
}
export const cityInfo = () => data?.manifest || null;

// ───────── drawing ─────────
const mpp = (lat, z) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

function roadWeights(z) {
  const m = mpp(31.52, z);
  const w = {};
  for (const [c, r] of Object.entries(ROADS)) {
    const fill = Math.max(r.min, r.m / m);
    w[c] = { fill, casing: fill + (z >= 15 ? 2 : 1) };
  }
  return w;
}

export function initCityMap(leafletMap) {
  map = leafletMap;
  for (const [pane, z] of [['cityArea', 205], ['cityLanduse', 210], ['cityBuildings', 220], ['cityRoads', 230], ['cityLabels', 390]]) {
    map.createPane(pane).style.zIndex = z;
  }
  map.getPane('cityLabels').style.pointerEvents = 'none';
  map.on('zoomend', () => { if (active) restyleRoads(); });
  map.on('moveend', () => { if (active) drawLabels(); });
}

function build() {
  if (!data || group) return;
  const P = data.parts;
  const renderer = (pane) => L.canvas({ pane, padding: 0.3 });
  group = L.layerGroup();

  // City area (inside the municipal boundary) in light grey, as on the paper map.
  if (P.boundary?.features.length) {
    L.geoJSON(P.boundary, { renderer: renderer('cityArea'), interactive: false,
      style: { color: COLORS.boundary, weight: 2.5, dashArray: '10,6', fillColor: COLORS.urban, fillOpacity: 1 } }).addTo(group);
  }
  const order = ['open', 'residential', 'planned', 'cemetery', 'industrial', 'commercial', 'institution', 'parking', 'park', 'sport', 'water'];
  const lu = [...(P.landuse?.features || [])].sort((a, b) => order.indexOf(a.properties.c) - order.indexOf(b.properties.c));
  L.geoJSON({ type: 'FeatureCollection', features: lu }, { renderer: renderer('cityLanduse'), interactive: false,
    style: (f) => ({ stroke: ['park', 'sport', 'institution'].includes(f.properties.c), color: '#ffffff', weight: 1,
      fillColor: COLORS.landuse[f.properties.c] || COLORS.urban, fillOpacity: 1 }) }).addTo(group);

  L.geoJSON(P.buildings, { renderer: renderer('cityBuildings'), interactive: false,
    style: (f) => { const [fill, line] = COLORS.building[f.properties.c] || COLORS.building.residential; return { color: line, weight: 0.8, fillColor: fill, fillOpacity: 1 }; } }).addTo(group);

  const roadRenderer = renderer('cityRoads');
  const byClass = {};
  for (const f of P.roads?.features || []) (byClass[f.properties.c] ||= []).push(f);
  roadLayers = {};
  // All casings first, then all fills, so crossings look clean.
  for (const pass of ['casing', 'fill']) {
    for (const c of ROAD_ORDER) {
      if (!byClass[c]) continue;
      const r = ROADS[c];
      const lyr = L.geoJSON({ type: 'FeatureCollection', features: byClass[c] }, { renderer: roadRenderer, interactive: false,
        style: { color: pass === 'casing' ? r.casing : r.fill, lineCap: 'round', lineJoin: 'round', dashArray: pass === 'fill' ? r.dash : null, opacity: c === 'path' && pass === 'fill' ? 0.9 : 1 } });
      lyr.addTo(group);
      roadLayers[`${pass}:${c}`] = lyr;
    }
  }
  for (const f of P.rail?.features || []) {
    const ll = f.geometry.coordinates.map(([x, y]) => [y, x]);
    L.polyline(ll, { renderer: roadRenderer, color: '#222', weight: 5, interactive: false }).addTo(group);
    L.polyline(ll, { renderer: roadRenderer, color: '#fff', weight: 3, dashArray: '12,12', interactive: false }).addTo(group);
  }

  labelLayer = L.layerGroup().addTo(group);
  prepareLabels();
  restyleRoads();
}

function restyleRoads() {
  const w = roadWeights(map.getZoom());
  for (const [key, lyr] of Object.entries(roadLayers)) {
    const [pass, c] = key.split(':');
    lyr.setStyle({ weight: pass === 'casing' ? w[c].casing : w[c].fill });
  }
}

// ───────── labels ─────────
function lengthM(a, b) {
  const dx = (b[0] - a[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180);
  const dy = (b[1] - a[1]) * 110540;
  return Math.hypot(dx, dy);
}

/** Label anchor points every `step` meters along a line (at least one for lines over 40 m): [{ ll, a, b }]. */
function samples(coords, step) {
  const out = [];
  const segs = [];
  let total = 0;
  for (let i = 1; i < coords.length; i++) { const len = lengthM(coords[i - 1], coords[i]); segs.push(len); total += len; }
  if (total < 40) return out;
  let next = Math.min(step / 2, total / 2);
  let walked = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]; const b = coords[i]; const len = segs[i - 1];
    while (len > 0 && next <= walked + len) {
      const t = (next - walked) / len;
      out.push({ ll: L.latLng(a[1] + (b[1] - a[1]) * t, a[0] + (b[0] - a[0]) * t), a: L.latLng(a[1], a[0]), b: L.latLng(b[1], b[0]) });
      next += step;
    }
    walked += len;
  }
  return out;
}

function prepareLabels() {
  streetCandidates = [];
  refCandidates = [];
  for (const f of data.parts.roads?.features || []) {
    const { n, r, c } = f.properties;
    if (n && c !== 'path') for (const s of samples(f.geometry.coordinates, 160)) streetCandidates.push({ ...s, text: n, major: ['major', 'primary', 'secondary'].includes(c) });
    if (r) for (const s of samples(f.geometry.coordinates, 900)) refCandidates.push({ ...s, text: r.split(';')[0] });
  }
}

const escHtml = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

function drawLabels() {
  if (!labelLayer) return;
  labelLayer.clearLayers();
  const z = map.getZoom();
  const bounds = map.getBounds().pad(0.1);
  const taken = new Set(); // occupied screen cells, to keep labels from piling up
  const occupy = (pt, w, h) => {
    const cells = [];
    for (let x = Math.floor((pt.x - w / 2) / 40); x <= Math.floor((pt.x + w / 2) / 40); x++) {
      for (let y = Math.floor((pt.y - h / 2) / 24); y <= Math.floor((pt.y + h / 2) / 24); y++) cells.push(`${x}:${y}`);
    }
    if (cells.some((c) => taken.has(c))) return false;
    cells.forEach((c) => taken.add(c));
    return true;
  };
  const add = (ll, html, cls, size) => labelLayer.addLayer(L.marker(ll, { pane: 'cityLabels', interactive: false, keyboard: false,
    icon: L.divIcon({ className: `city-label ${cls}`, html, iconSize: size, iconAnchor: [size[0] / 2, size[1] / 2] }) }));

  // Neighborhood names (big), like "נאות השקמה" on the paper map.
  if (z >= 13 && z <= 17) {
    for (const f of data.parts.labels?.features || []) {
      if (f.properties.k === 'city' || f.properties.k === 'town') continue;
      const ll = L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]);
      if (!bounds.contains(ll)) continue;
      const pt = map.latLngToContainerPoint(ll);
      const w = f.properties.n.length * 9 + 16;
      if (occupy(pt, w, 22)) add(ll, `<span>${escHtml(f.properties.n)}</span>`, 'hood', [w, 22]);
    }
  }
  // Road numbers: red for national roads, green for regional ones.
  if (z >= 12) {
    const seen = new Set();
    for (const c of refCandidates) {
      if (!bounds.contains(c.ll)) continue;
      const pt = map.latLngToContainerPoint(c.ll);
      const key = `${c.text}:${Math.floor(pt.x / 260)}:${Math.floor(pt.y / 260)}`;
      if (seen.has(key)) continue;
      if (occupy(pt, 34, 20)) { seen.add(key); add(c.ll, `<span>${escHtml(c.text)}</span>`, Number(c.text) >= 100 ? 'ref regional' : 'ref national', [34, 20]); }
    }
  }
  // Street names written along the street.
  if (z >= 16) {
    const seen = new Set();
    const cell = z >= 18 ? 220 : 300;
    for (const c of streetCandidates) {
      if (!bounds.contains(c.ll)) continue;
      if (!c.major && z < 16) continue;
      const pt = map.latLngToContainerPoint(c.ll);
      const key = `${c.text}:${Math.floor(pt.x / cell)}:${Math.floor(pt.y / cell)}`;
      if (seen.has(key)) continue;
      const pa = map.latLngToContainerPoint(c.a); const pb = map.latLngToContainerPoint(c.b);
      let angle = (Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180) / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      const w = c.text.length * 7 + 8;
      const horiz = Math.abs(Math.cos((angle * Math.PI) / 180));
      if (!occupy(pt, w * horiz + 14, w * (1 - horiz) + 14)) continue;
      seen.add(key);
      add(c.ll, `<span style="transform:rotate(${angle.toFixed(1)}deg)">${escHtml(c.text)}</span>`, 'street', [w, 16]);
    }
  }
  // Symbols of public places (from zoom 16), with their names from zoom 17.
  if (z >= 16) {
    for (const f of data.parts.pois?.features || []) {
      const ll = L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]);
      if (!bounds.contains(ll)) continue;
      const pt = map.latLngToContainerPoint(ll);
      const name = z >= 17 && f.properties.n ? `<em>${escHtml(f.properties.n)}</em>` : '';
      if (occupy(pt, 24, 24)) add(ll, `<b title="${escHtml(POI_NAMES[f.properties.k] || '')}">${POI_ICONS[f.properties.k] || '•'}</b>${name}`, 'poi', [24, 24]);
    }
  }
}

/** Show or hide the city map. Returns false when there is no city data yet. */
export function setCityMap(on) {
  if (on && !data) return false;
  active = on;
  map.getContainer().classList.toggle('city-bg', on);
  if (on) {
    build();
    group.addTo(map);
    restyleRoads();
    drawLabels();
  } else if (group) {
    map.removeLayer(group);
  }
  return true;
}

/** Forget the drawn layers (after a re-import) so the next setCityMap(true) rebuilds them. */
export function resetCityMap() {
  if (group && map) map.removeLayer(group);
  group = null;
  roadLayers = {};
  labelLayer = null;
}

export function legendHtml() {
  const sw = (fill, line = fill) => `<i style="background:${fill};border-color:${line}"></i>`;
  const rows = [
    [sw(COLORS.urban, '#999'), 'שטח עירוני'], [sw(COLORS.landuse.park), 'גן ציבורי / פארק'], [sw(COLORS.landuse.industrial), 'אזור תעשייה'],
    [sw(COLORS.landuse.institution), 'שטח למוסד ציבורי'], [sw(COLORS.landuse.commercial), 'אזור מסחר'], [sw(COLORS.landuse.planned), 'בבנייה / בתכנון'],
    [sw(...COLORS.building.residential), 'מבנה מגורים'], [sw(...COLORS.building.public), 'מבנה ציבורי'], [sw(...COLORS.building.commercial), 'מבנה מסחרי'],
    [sw(...COLORS.building.industrial), 'מבנה תעשייה'], [sw(ROADS.major.fill, ROADS.major.casing), 'כביש ראשי'], [sw('#fff', '#888'), 'רחוב'],
    ['<span class="legend-ref national">34</span>', 'מספר כביש ארצי'], ['<span class="legend-ref regional">232</span>', 'מספר כביש אזורי'],
  ];
  const pois = Object.entries(POI_ICONS).map(([k, icon]) => `<span class="legend-poi">${icon} ${POI_NAMES[k]}</span>`).join('');
  return `<div class="legend-grid">${rows.map(([s, t]) => `<div>${s}<span>${t}</span></div>`).join('')}</div><div class="legend-pois">${pois}</div>`;
}
