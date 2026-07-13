/**
 * OpenGate Filebase upload proxy — api/filebase-upload.js
 *
 * Чому серверна функція, а не пряме звернення з браузера:
 *  - Filebase повертає CID (IPFS-адресу файлу) у нестандартному заголовку
 *    відповіді (x-amz-meta-cid). Браузер може заблокувати читання такого
 *    заголовка через CORS — сервер такого обмеження не має взагалі.
 *  - Секретний ключ (Secret Key) тут не світиться у відкритому коді
 *    сторінки — це безпечніше, ніж тримати його у фронтенді.
 *
 * Використання (з фронтенду):
 *   POST /api/filebase-upload
 *   body: { bucket: "opengate-tokens" | "opengate-nft",
 *           filename: "logo.png",
 *           contentType: "image/png",
 *           dataBase64: "<base64 без префікса data:...>" }
 *   -> { cid: "...", url: "https://ipfs.filebase.io/ipfs/..." }
 *
 * Налаштування (Vercel → Settings → Environment Variables), НЕ у коді:
 *   FILEBASE_TOKENS_ACCESS_KEY / FILEBASE_TOKENS_SECRET_KEY   — акаунт №1 (токени)
 *   FILEBASE_NFT_ACCESS_KEY    / FILEBASE_NFT_SECRET_KEY      — акаунт №2 (NFT Studio)
 */

const crypto = require('crypto');

const ENDPOINT_HOST = 's3.filebase.com'; // офіційний, стабільний S3-ендпоінт Filebase
const REGION = 'us-east-1';
const SERVICE = 's3';

function hmac(key, msg) {
  return crypto.createHmac('sha256', key).update(msg, 'utf8').digest();
}
function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// AWS Signature Version 4 — підписуємо PUT-запит на завантаження файлу.
function signRequest({ method, host, path, accessKey, secretKey, region, service, payloadHash, extraHeaders }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);

  const headers = Object.assign({
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }, extraHeaders || {});

  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = sortedHeaderKeys.join(';');

  const canonicalRequest = [
    method,
    path,
    '', // query string (none)
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac('AWS4' + secretKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope},SignedHeaders=${signedHeaders},Signature=${signature}`;

  return { amzDate, authHeader, headers };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST' }); return; }

  try {
    const { bucket, filename, contentType, dataBase64 } = req.body || {};
    if (!bucket || !filename || !dataBase64) {
      res.status(400).json({ error: 'Missing bucket, filename, or dataBase64' });
      return;
    }

    let accessKey, secretKey;
    if (bucket === 'opengate-tokens') {
      accessKey = process.env.FILEBASE_TOKENS_ACCESS_KEY;
      secretKey = process.env.FILEBASE_TOKENS_SECRET_KEY;
    } else if (bucket === 'opengate-nft') {
      accessKey = process.env.FILEBASE_NFT_ACCESS_KEY;
      secretKey = process.env.FILEBASE_NFT_SECRET_KEY;
    } else {
      res.status(400).json({ error: 'Unknown bucket' });
      return;
    }
    if (!accessKey || !secretKey) {
      res.status(500).json({ error: 'Filebase credentials not configured on the server' });
      return;
    }

    const buffer = Buffer.from(dataBase64, 'base64');
    const payloadHash = sha256hex(buffer);
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = Date.now() + '-' + safeName;
    const path = `/${bucket}/${key}`;

    const { amzDate, authHeader, headers } = signRequest({
      method: 'PUT',
      host: ENDPOINT_HOST,
      path,
      accessKey,
      secretKey,
      region: REGION,
      service: SERVICE,
      payloadHash,
      extraHeaders: { 'content-type': contentType || 'application/octet-stream' },
    });

    const upstream = await fetch(`https://${ENDPOINT_HOST}${path}`, {
      method: 'PUT',
      headers: {
        Host: ENDPOINT_HOST,
        Authorization: authHeader,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
        'Content-Type': contentType || 'application/octet-stream',
      },
      body: buffer,
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      res.status(502).json({ error: 'Filebase upload failed: ' + upstream.status, detail: text.slice(0, 300) });
      return;
    }

    const cid = upstream.headers.get('x-amz-meta-cid');
    if (!cid) {
      res.status(502).json({ error: 'Upload succeeded but no CID was returned' });
      return;
    }

    res.status(200).json({ cid, url: `https://ipfs.filebase.io/ipfs/${cid}` });
  } catch (e) {
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
};
