import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCityMap } from '../api/_lib/citymap.js';
import { fakeOverpass } from './fixtures/fake-overpass.mjs';

test('city map parts are built from Overpass data', () => {
  const { parts, base, stats } = buildCityMap(fakeOverpass());
  assert.equal(stats.boundary, true);
  assert.ok(parts.buildings.features.length >= 31);
  const classes = new Set(parts.buildings.features.map((f) => f.properties.c));
  assert.ok(classes.has('residential') && classes.has('public') && classes.has('industrial'), [...classes].join());
  assert.ok(parts.roads.features.some((f) => f.properties.r === '34' && f.properties.c === 'major'));
  assert.ok(parts.landuse.features.some((f) => f.properties.c === 'park'));
  assert.ok(parts.landuse.features.some((f) => f.properties.c === 'institution'));
  assert.deepEqual(parts.labels.features.map((f) => f.properties.n).sort(), ['נאות אשכול', 'נאות השקמה']);
  assert.ok(parts.pois.features.some((f) => f.properties.k === 'police'));
  const layers = base.features.map((f) => f.properties.layer);
  assert.ok(layers.includes('hydrants') && layers.includes('aed') && layers.includes('shelters'));
  assert.equal(layers.filter((l) => l === 'shelters').length, 1, 'bus shelters are not bomb shelters');
});

test('a building with no use tag takes the use of the zone it stands in', () => {
  const { parts } = buildCityMap(fakeOverpass());
  const inZone = parts.buildings.features.find((f) => f.geometry.coordinates[0][0][0] === 34.6085);
  assert.equal(inZone.properties.c, 'industrial');
  const outside = parts.buildings.features.find((f) => f.geometry.coordinates[0][0][0] === 34.5851);
  assert.equal(outside.properties.c, 'residential');
});
