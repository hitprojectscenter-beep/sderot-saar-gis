// GET /api/govmap → the open layers published by GovMap's WMS (open.govmap.gov.il), as [{name, title}].
// The browser cannot read GovMap's capabilities directly (CORS), so the server reads and caches them.
const WMS = 'https://open.govmap.gov.il/geoserver/opendata/wms';
let cache = null;

function decode(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
}

export default async function handler(req, res) {
  try {
    if (!cache || Date.now() - cache.at > 6 * 3600e3) {
      const r = await fetch(`${WMS}?service=WMS&version=1.3.0&request=GetCapabilities`, { headers: { 'User-Agent': 'sderot-saar-gis/0.2' } });
      if (!r.ok) throw new Error(`GovMap: HTTP ${r.status}`);
      const xml = await r.text();
      const layers = [];
      // Leaf layers: <Layer queryable=…><Name>ws:NAME</Name><Title>…</Title>
      for (const m of xml.matchAll(/<Layer[^>]*>\s*<Name>([^<]+)<\/Name>\s*<Title>([\s\S]*?)<\/Title>/g)) {
        layers.push({ name: decode(m[1]), title: decode(m[2]) });
      }
      cache = { at: Date.now(), layers };
    }
    res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
    return res.status(200).json({ wms: WMS, layers: cache.layers });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: `לא ניתן לקרוא את רשימת השכבות של GovMap (${e.message})`, wms: WMS, layers: [] });
  }
}
