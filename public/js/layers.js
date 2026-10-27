// Layer catalog and automatic layer classification.
// Shared by the browser app and the API (the server validates layer ids with it),
// so this module must stay free of DOM code.

export const GROUPS = [
  { id: 'city', name: 'מרחב העיר' },
  { id: 'protection', name: 'מיגון' },
  { id: 'fire', name: 'כיבוי אש' },
  { id: 'medical', name: 'רפואה והצלה' },
  { id: 'security', name: 'מרכיבי ביטחון' },
  { id: 'infra', name: 'תשתיות ומפגעים קבועים' },
  { id: 'population', name: 'אוכלוסיות ומוסדות' },
  { id: 'unit', name: 'היחידה וקהילה בחירום' },
  { id: 'event', name: 'אירוע (זמן אמת)' },
  { id: 'general', name: 'כללי' },
];

// geom: which geometry types the layer accepts (Point / LineString / Polygon).
// keywords: Hebrew/English words that identify the layer in a name or description.
// They are matched after normalization (no gershayim, quotes or niqqud), so 'ממ"ד' matches 'ממד'.
export const LAYERS = [
  // ── City space ──
  { id: 'neighborhoods', group: 'city', name: 'שכונות', icon: '🏘', color: '#8e44ad', geom: ['Polygon', 'Point'],
    keywords: ['שכונה', 'שכונת', 'נאות', 'רובע', 'neighborhood'] },
  { id: 'sectors', group: 'city', name: 'גזרות סע״ר', icon: '🗺', color: '#e67e22', geom: ['Polygon'],
    keywords: ['גזרה', 'גזרת', 'סקטור', 'צוות 1', 'צוות 2', 'צוות 3', 'צוות 4'] },
  { id: 'streets', group: 'city', name: 'רחובות', icon: '🛣', color: '#7f8c8d', geom: ['LineString'],
    keywords: ['רחוב', 'רח', 'סמטה', 'כביש', 'דרך', 'שדרת', 'street', 'road'] },
  { id: 'risk_buildings', group: 'city', name: 'מבנים בסיכון', icon: '⚠', color: '#c0392b', geom: ['Polygon', 'Point'],
    keywords: ['קומת עמודים', 'מבנה מסוכן', 'מבנה ישן', 'תקן 413', 'סכנת קריסה', 'מסוכן', 'סדוק', 'תמא'] },
  // weight < 1: generic words ("בניין") lose to specific ones ("בניין פגוע" → damage).
  { id: 'buildings', group: 'city', name: 'מבנים', icon: '🏢', color: '#95a5a6', geom: ['Polygon', 'Point'], weight: 0.4,
    keywords: ['בניין', 'בנין', 'מבנה', 'בית', 'קומות', 'building'] },

  // ── Protection ──
  { id: 'shelters', group: 'protection', name: 'מקלטים ציבוריים', icon: '🛡', color: '#2c3e50', geom: ['Point', 'Polygon'],
    keywords: ['מקלט', 'מקלטים', 'shelter', 'bunker'] },
  { id: 'mamad', group: 'protection', name: 'ממ״דים וממ״קים', icon: '🚪', color: '#34495e', geom: ['Point', 'Polygon'],
    keywords: ['ממד', 'ממדים', 'ממק', 'מרחב מוגן', 'חדר ביטחון', 'חדר מוגן'] },
  { id: 'migunit', group: 'protection', name: 'מיגוניות', icon: '🧱', color: '#566573', geom: ['Point'],
    keywords: ['מיגונית', 'מיגוניות', 'מגונית'] },

  // ── Fire ──
  { id: 'hydrants', group: 'fire', name: 'ברזי כיבוי (הידרנטים)', icon: '🚒', color: '#e74c3c', geom: ['Point'],
    keywords: ['ברז כיבוי', 'ברזי כיבוי', 'הידרנט', 'ברז שריפה', 'ברז', 'hydrant'] },
  { id: 'fire_equipment', group: 'fire', name: 'עמדות ואמצעי כיבוי', icon: '🧯', color: '#d35400', geom: ['Point'],
    keywords: ['מטף', 'מטפים', 'עמדת כיבוי', 'גלגלון', 'זרנוק', 'ארון כיבוי', 'כיבוי אש'] },
  { id: 'water_sources', group: 'fire', name: 'מקורות מים', icon: '💧', color: '#2980b9', geom: ['Point', 'Polygon'],
    keywords: ['מאגר מים', 'מגדל מים', 'בריכה', 'מקור מים', 'בריכת שחייה', 'water'] },

  // ── Medical & rescue ──
  { id: 'aed', group: 'medical', name: 'דפיברילטורים', icon: '❤', color: '#e91e63', geom: ['Point'],
    keywords: ['דפיברילטור', 'דיפיברילטור', 'דפיברלטור', 'דיפיברלטור', 'דפי', 'מפעם', 'aed', 'defibrillator'] },
  { id: 'first_aid', group: 'medical', name: 'ערכות עזרה ראשונה', icon: '🩹', color: '#f06292', geom: ['Point'],
    keywords: ['עזרה ראשונה', 'ערכת', 'ערכה', 'תרמיל', 'אלונקה', 'אלונקות', 'first aid'] },
  { id: 'emergency_services', group: 'medical', name: 'משטרה, כב״ה ומד״א', icon: '🚓', color: '#1565c0', geom: ['Point', 'Polygon'],
    keywords: ['משטרה', 'תחנת משטרה', 'כבאות', 'כבאי', 'תחנת כיבוי', 'מדא', 'איחוד הצלה', 'פקער', 'פיקוד העורף', 'police'] },
  { id: 'medical_sites', group: 'medical', name: 'מרפאות וקופות חולים', icon: '🏥', color: '#ad1457', geom: ['Point', 'Polygon'],
    keywords: ['קופת חולים', 'קופח', 'מרפאה', 'מוקד רפואי', 'טיפת חלב', 'בית מרקחת', 'clinic', 'pharmacy'] },
  { id: 'evac_points', group: 'medical', name: 'נקודות פינוי נפגעים', icon: '🚑', color: '#c2185b', geom: ['Point', 'Polygon'],
    keywords: ['נקודת פינוי', 'פינוי נפגעים', 'נקודת איסוף נפגעים', 'מנחת', 'מנחת מסוקים', 'פינוי'] },

  // ── Security ──
  { id: 'security', group: 'security', name: 'מרכיבי ביטחון', icon: '🛂', color: '#455a64', geom: ['Point', 'LineString', 'Polygon'],
    keywords: ['מצלמה', 'מצלמות', 'מצלמת', 'אבטחה', 'גדר', 'שער', 'צופר', 'אזעקה', 'כיתת כוננות', 'עמדת שמירה', 'מחסום', 'פילבוקס', 'תאורת ביטחון', 'קבט'] },

  // ── Infrastructure & permanent hazards ──
  { id: 'hazards_infra', group: 'infra', name: 'תשתיות מסוכנות', icon: '☢', color: '#f39c12', geom: ['Point', 'LineString', 'Polygon'],
    keywords: ['גז', 'מגוף', 'חשמל', 'שנאי', 'חדר חשמל', 'תחנת דלק', 'דלק', 'חומרים מסוכנים', 'חומס', 'ביוב', 'קו מים', 'צנרת'] },

  // ── Populations & institutions ──
  { id: 'special_pop', group: 'population', name: 'מוסדות ואוכלוסיות מיוחדות', icon: '🧒', color: '#16a085', geom: ['Point', 'Polygon'],
    keywords: ['גן ילדים', 'גן', 'בית ספר', 'ביס', 'מעון', 'מרכז יום', 'בית אבות', 'דיור מוגן', 'קשיש', 'קשישים', 'נכים', 'מוגבלות', 'ישיבה', 'אולפנה', 'school', 'kindergarten'] },
  { id: 'public_sites', group: 'population', name: 'מבני ציבור', icon: '🏛', color: '#1abc9c', geom: ['Point', 'Polygon'],
    keywords: ['עירייה', 'עיריה', 'מתנס', 'בית כנסת', 'מקווה', 'מועדון', 'אולם', 'קניון', 'מרכז מסחרי', 'סופר', 'בנק', 'דואר', 'ספרייה'] },

  // ── Unit & community in emergency ──
  { id: 'unit_sites', group: 'unit', name: 'חפ״ק, מחסנים וכינוס', icon: '⛺', color: '#ff5722', geom: ['Point', 'Polygon'],
    keywords: ['חפק', 'מחסן', 'מחסני', 'מרכז חבירה', 'נקודת כינוס', 'כינוס', 'גנרטור', 'ציוד חילוץ'] },
  { id: 'gathering', group: 'unit', name: 'שטחי כינוס וקליטה לתושבים', icon: '👥', color: '#27ae60', geom: ['Point', 'Polygon'],
    keywords: ['שטח כינוס', 'שטח פתוח', 'מרכז קליטה', 'קליטת מפונים', 'מסר', 'מרכז סיוע', 'חלוקת מים', 'חלוקת מזון', 'פארק', 'מגרש'] },

  // ── Live event ──
  { id: 'damage', group: 'event', name: 'מבנים פגועים', icon: '🏚', color: '#b71c1c', geom: ['Point', 'Polygon'],
    keywords: ['פגוע', 'פגועים', 'הרס', 'הרוס', 'קריסה', 'קרס', 'נזק', 'פגיעה', 'נפילה', 'נפילת', 'טיל', 'רקטה', 'כטבם', 'רעידת אדמה'] },
  { id: 'casualties', group: 'event', name: 'לכודים, נעדרים ונפגעים', icon: '🆘', color: '#d50000', geom: ['Point'],
    keywords: ['לכוד', 'לכודים', 'נעדר', 'נעדרים', 'נפגע', 'נפגעים', 'פצוע', 'פצועים', 'הרוג', 'חילוץ'] },
  { id: 'cleared', group: 'event', name: 'דירות ומבנים שזוכו', icon: '✅', color: '#2e7d32', geom: ['Point', 'Polygon'],
    keywords: ['זוכה', 'זוכתה', 'זיכוי', 'נסרק', 'נסרקה', 'סרוק', 'סומן', 'ריק', 'ריקה'] },
  { id: 'event_hazards', group: 'event', name: 'מפגעים באירוע', icon: '🔥', color: '#ff6f00', geom: ['Point', 'Polygon'],
    keywords: ['מפגע', 'דליפה', 'דליפת', 'שריפה', 'שרפה', 'עשן', 'חוט חשמל', 'כבל קרוע', 'סכנה', 'הצפה'] },
  { id: 'blocked_routes', group: 'event', name: 'צירים חסומים', icon: '⛔', color: '#000000', geom: ['LineString'],
    keywords: ['חסום', 'חסומה', 'חסימה', 'ציר חסום', 'הריסות', 'לא עביר', 'סגור לתנועה'] },
  { id: 'scene', group: 'event', name: 'זירות ואזורי סריקה', icon: '🎯', color: '#ff1744', geom: ['Polygon'],
    keywords: ['זירה', 'זירת', 'אזור הרס', 'אזור סריקה', 'טבעת', 'מעגל סריקה'] },

  // ── General (fallback by geometry) ──
  { id: 'general_point', group: 'general', name: 'נקודות כלליות', icon: '📍', color: '#607d8b', geom: ['Point'], keywords: [] },
  { id: 'general_line', group: 'general', name: 'קווים כלליים', icon: '〰', color: '#607d8b', geom: ['LineString'], keywords: [] },
  { id: 'general_polygon', group: 'general', name: 'אזורים כלליים', icon: '⬛', color: '#607d8b', geom: ['Polygon'], keywords: [] },
];

export const LAYER_BY_ID = Object.fromEntries(LAYERS.map((l) => [l.id, l]));

const FALLBACK = { Point: 'general_point', LineString: 'general_line', Polygon: 'general_polygon' };

/** Collapse geometry variants (MultiPolygon etc.) into the three basic kinds. */
export function baseGeomType(type) {
  if (!type) return 'Point';
  if (type.includes('Polygon')) return 'Polygon';
  if (type.includes('LineString')) return 'LineString';
  return 'Point';
}

/** Lower-case, drop niqqud, quotes, gershayim and punctuation so spellings compare equal. */
export function normalizeText(s) {
  return ` ${String(s || '')
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '') // niqqud + cantillation
    .replace(/["'`״׳‘’“”]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;
}

// Hebrew prefixes (ו, ה, ב, ל, מ, ש, כ) can be glued to a word: "והמקלט", "בממד".
const PREFIX = '(?:[והבלמשכ]{0,2})';
const keywordPatterns = new Map();
function patternFor(keyword) {
  if (!keywordPatterns.has(keyword)) {
    const words = normalizeText(keyword).trim().split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    keywordPatterns.set(keyword, new RegExp(`(?:^|\\s)${PREFIX}${words.join('\\s+')}(?=\\s|$)`, 'u'));
  }
  return keywordPatterns.get(keyword);
}

/**
 * Suggest the layer for a new item from its name, description and geometry.
 * Longer (more specific) keyword matches win; a match in the name counts double.
 * Returns { layerId, keyword, confident }.
 */
export function classify({ name = '', description = '', geometryType = 'Point' } = {}) {
  const geom = baseGeomType(geometryType);
  const nameText = normalizeText(name);
  const descText = normalizeText(description);
  let best = null;
  for (const layer of LAYERS) {
    if (!layer.keywords.length) continue;
    for (const kw of layer.keywords) {
      const re = patternFor(kw);
      const inName = re.test(nameText);
      const inDesc = !inName && re.test(descText);
      if (!inName && !inDesc) continue;
      let score = normalizeText(kw).trim().length * (inName ? 2 : 1) * (layer.weight || 1);
      if (!layer.geom.includes(geom)) score *= 0.25; // keyword fits but geometry does not
      if (!best || score > best.score) best = { layerId: layer.id, keyword: kw, score, geomOk: layer.geom.includes(geom) };
    }
  }
  if (best && best.geomOk) return { layerId: best.layerId, keyword: best.keyword, confident: true };
  if (best) {
    // The words point to a layer that does not accept this geometry: keep the hint, fall back by geometry.
    return { layerId: FALLBACK[geom], keyword: best.keyword, confident: false, hintLayerId: best.layerId };
  }
  return { layerId: FALLBACK[geom], keyword: null, confident: false };
}

export function isValidLayer(id, geometryType) {
  const layer = LAYER_BY_ID[id];
  return !!layer && layer.geom.includes(baseGeomType(geometryType));
}
