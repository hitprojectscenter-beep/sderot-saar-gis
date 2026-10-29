// Request body as an object. Malformed JSON gives null instead of a crash
// (on Vercel, merely reading req.body throws when the JSON is invalid).
export function readJson(req) {
  try {
    const b = req.body;
    if (b == null || b === '') return {};
    if (typeof b === 'string') return JSON.parse(b);
    return typeof b === 'object' ? b : null;
  } catch {
    return null;
  }
}
