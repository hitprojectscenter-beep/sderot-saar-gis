// Copies browser libraries from node_modules into public/vendor so the app
// works offline and does not depend on a CDN during an emergency.
import { cpSync, mkdirSync } from 'node:fs';

const out = 'public/vendor';
const files = [
  ['node_modules/leaflet/dist/leaflet.js', 'leaflet/leaflet.js'],
  ['node_modules/leaflet/dist/leaflet.css', 'leaflet/leaflet.css'],
  ['node_modules/leaflet/dist/images', 'leaflet/images'],
  ['node_modules/@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.min.js', 'geoman/leaflet-geoman.min.js'],
  ['node_modules/@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css', 'geoman/leaflet-geoman.css'],
];
for (const [from, to] of files) {
  mkdirSync(`${out}/${to}`.replace(/\/[^/]+$/, ''), { recursive: true });
  cpSync(from, `${out}/${to}`, { recursive: true });
}
console.log('vendor libraries copied to', out);
