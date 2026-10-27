// A small synthetic Overpass response shaped like real OSM data around Sderot (for tests and local demo).
const C = [34.5965, 31.5245];
let id = 1;
const node = (lon, lat, tags) => ({ type: 'node', id: id++, lat, lon, tags });
const way = (coords, tags) => ({ type: 'way', id: id++, tags, geometry: coords.map(([lon, lat]) => ({ lon, lat })) });
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];

export function fakeOverpass() {
  id = 1;
  const el = [];
  const [cx, cy] = C;
  el.push({ type: 'relation', id: id++, tags: { boundary: 'administrative', admin_level: '8', name: 'שדרות' },
    members: [{ type: 'way', role: 'outer', geometry: rect(cx - 0.02, cy - 0.016, 0.04, 0.032).map(([lon, lat]) => ({ lon, lat })) }] });
  el.push(way(rect(cx + 0.008, cy - 0.012, 0.01, 0.008), { landuse: 'industrial' }));
  el.push(way(rect(cx - 0.006, cy + 0.002, 0.004, 0.003), { leisure: 'park', name: 'פארק השקמה' }));
  el.push(way(rect(cx + 0.001, cy + 0.001, 0.002, 0.0015), { amenity: 'school', name: 'בית ספר אמית' }));
  el.push(way(rect(cx - 0.015, cy - 0.012, 0.03, 0.026), { landuse: 'residential' }));
  const names = ['הרצל', 'ז׳בוטינסקי', 'הנביאים', 'בן גוריון', 'יוסף', 'רמב״ם', 'השקמה', 'הדקל'];
  for (let i = 0; i < 6; i++) {
    const y = cy - 0.009 + i * 0.003;
    el.push(way([[cx - 0.014, y], [cx + 0.012, y + 0.0004]], { highway: i === 2 ? 'secondary' : 'residential', name: names[i] }));
    const x = cx - 0.012 + i * 0.004;
    el.push(way([[x, cy - 0.011], [x + 0.0006, cy + 0.009]], { highway: 'residential', name: names[(i + 3) % names.length] }));
    for (let j = 0; j < 5; j++) {
      const bx = x + 0.0006; const by = cy - 0.0085 + j * 0.003;
      el.push(way(rect(bx, by, 0.0012, 0.0008), { building: j === 2 && i === 3 ? 'school' : 'yes', ...(j === 0 ? { 'addr:street': names[i], 'addr:housenumber': String(j + 1) } : {}) }));
    }
  }
  el.push(way(rect(cx + 0.012, cy - 0.01, 0.0015, 0.001), { building: 'yes' })); // inside industrial → purple
  el.push(way([[cx - 0.025, cy - 0.03], [cx - 0.02, cy + 0.03]], { highway: 'trunk', ref: '34', name: 'כביש 34' }));
  el.push(way([[cx + 0.022, cy - 0.03], [cx + 0.03, cy + 0.03]], { highway: 'primary', ref: '232' }));
  el.push(way([[cx - 0.028, cy - 0.03], [cx - 0.024, cy + 0.03]], { railway: 'rail' }));
  el.push(node(cx - 0.004, cy + 0.006, { place: 'neighbourhood', name: 'נאות השקמה' }));
  el.push(node(cx + 0.004, cy - 0.006, { place: 'neighbourhood', name: 'נאות אשכול' }));
  el.push(node(cx + 0.0005, cy + 0.0005, { amenity: 'place_of_worship', name: 'בית כנסת מרכזי' }));
  el.push(node(cx + 0.002, cy - 0.002, { emergency: 'fire_hydrant' }));
  el.push(node(cx - 0.002, cy - 0.001, { emergency: 'defibrillator', name: 'דפיברילטור מתנ״ס' }));
  el.push(node(cx - 0.003, cy + 0.0035, { amenity: 'shelter', shelter_type: 'bomb_shelter', name: 'מקלט 12' }));
  el.push(node(cx - 0.001, cy + 0.003, { amenity: 'shelter', shelter_type: 'public_transport' })); // bus stop: skipped
  el.push(node(cx + 0.005, cy + 0.004, { amenity: 'police', name: 'תחנת משטרה שדרות' }));
  return { elements: el };
}
