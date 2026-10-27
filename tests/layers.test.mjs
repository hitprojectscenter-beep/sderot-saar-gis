import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, normalizeText, isValidLayer } from '../public/js/layers.js';

const cases = [
  [{ name: 'מקלט ציבורי 12', geometryType: 'Point' }, 'shelters'],
  [{ name: 'ממ"ד בקומה 2', geometryType: 'Point' }, 'mamad'],
  [{ name: 'ממ״ד', geometryType: 'Point' }, 'mamad'],
  [{ name: 'ברז כיבוי ליד הגן', geometryType: 'Point' }, 'hydrants'],
  [{ name: 'דיפיברלטור בלובי', geometryType: 'Point' }, 'aed'],
  [{ name: 'AED', geometryType: 'Point' }, 'aed'],
  [{ name: 'בניין פגוע', description: 'קריסה חלקית', geometryType: 'Polygon' }, 'damage'],
  [{ name: 'ציר חסום בהריסות', geometryType: 'LineString' }, 'blocked_routes'],
  [{ name: 'שכונת נאות השקמה', geometryType: 'Polygon' }, 'neighborhoods'],
  [{ name: 'גזרה 3', geometryType: 'Polygon' }, 'sectors'],
  [{ name: 'נקודה', description: 'נעדר – אישה בת 82', geometryType: 'Point' }, 'casualties'],
  [{ name: 'דליפת גז', geometryType: 'Point' }, 'event_hazards'],
  [{ name: 'מגוף גז ראשי', geometryType: 'Point' }, 'hazards_infra'],
  [{ name: 'חפ"ק עיקרי', geometryType: 'Point' }, 'unit_sites'],
  [{ name: 'גן ילדים רימון', geometryType: 'Point' }, 'special_pop'],
  [{ name: 'מצלמת אבטחה', geometryType: 'Point' }, 'security'],
  [{ name: 'בניין מגורים 4 קומות', geometryType: 'Polygon' }, 'buildings'],
  [{ name: 'מצלמה', geometryType: 'Point' }, 'security'],
  [{ name: 'והמקלט', geometryType: 'Point' }, 'shelters'],
  [{ name: 'סתם משהו', geometryType: 'LineString' }, 'general_line'],
];

for (const [input, expected] of cases) {
  test(`classify "${input.name} ${input.description || ''}" → ${expected}`, () => {
    assert.equal(classify(input).layerId, expected);
  });
}

test('keyword whose layer rejects the geometry falls back but keeps the hint', () => {
  const r = classify({ name: 'מקלט', geometryType: 'LineString' });
  assert.equal(r.layerId, 'general_line');
  assert.equal(r.hintLayerId, 'shelters');
});

test('normalizeText strips gershayim and quotes', () => {
  assert.equal(normalizeText('ממ"ד'), normalizeText('ממ״ד'));
  assert.equal(normalizeText('ממ"ד').trim(), 'ממד');
});

test('isValidLayer checks geometry', () => {
  assert.equal(isValidLayer('blocked_routes', 'LineString'), true);
  assert.equal(isValidLayer('blocked_routes', 'Point'), false);
  assert.equal(isValidLayer('nope', 'Point'), false);
});
