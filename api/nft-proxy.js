/**
 * OpenGate NFT metadata proxy — api/nft-proxy.js
 *
 * Навіщо: коли хтось виставляє на маркетплейс СВІЙ, чужий NFT, його
 * tokenURI може вести на будь-який сторонній сервер. Багато таких
 * серверів не додають заголовок Access-Control-Allow-Origin (бо їх
 * автори просто не думали про це) — і браузер тоді блокує fetch()
 * з нашого сайту, хоча дані самі по собі публічні й нормальні.
 *
 * Рішення: сервер (не браузер) не має обмежень CORS взагалі. Тому цей
 * ендпоінт сам ходить на сторонній URL, забирає відповідь, і віддає її
 * назад на наш сайт з нашим власним CORS-заголовком. Так спрацює для
 * будь-якого NFT, незалежно від того, як налаштований чужий сервер.
 *
 * Використання: /api/nft-proxy?url=<encoded tokenURI>
 *
 * Безпека: дозволені лише http/https, є ліміт часу і розміру відповіді,
 * щоб цей ендпоінт не можна було перетворити на відкритий проксі для
 * чогось іншого (SSRF-захист).
 */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const target = String(req.query.url || '');
  if (!target) {
    res.status(400).json({ error: 'Missing ?url=' });
    return;
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch (e) {
    res.status(400).json({ error: 'Invalid URL' });
    return;
  }

  // Only allow fetching public http/https resources — never internal
  // addresses, to prevent this endpoint being abused as an open proxy.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    res.status(400).json({ error: 'Only http/https URLs are allowed' });
    return;
  }
  const host = parsed.hostname.toLowerCase();
  const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
  if (blocked.includes(host) || host.endsWith('.local') || host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('169.254.')) {
    res.status(400).json({ error: 'This host is not allowed' });
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const upstream = await fetch(target, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timeout);

    if (!upstream.ok) {
      res.status(502).json({ error: 'Upstream returned ' + upstream.status });
      return;
    }

    // Cap response size (metadata JSON should always be tiny)
    const MAX_BYTES = 1024 * 1024; // 1MB
    const buf = await upstream.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      res.status(502).json({ error: 'Upstream response too large' });
      return;
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=300'); // short cache — third-party data can change
    res.status(200).send(Buffer.from(buf));
  } catch (e) {
    res.status(502).json({ error: 'Fetch failed: ' + (e.message || 'unknown error') });
  }
};
