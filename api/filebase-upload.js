/**
 * OpenGate upload service — api/filebase-upload.js
 *
 * Ця функція робить дві речі:
 *
 *  1) ВИДАЧА КЛЮЧІВ PINATA (action: 'pinataKey')
 *     Головний ключ Pinata живе ТІЛЬКИ у змінних оточення Vercel і в браузер
 *     не потрапляє ніколи. Браузер отримує тимчасовий ключ з урізаними
 *     правами, яким можна лише завантажувати (pinFileToIPFS / pinJSONToIPFS)
 *     і який згорає після N використань. Навіть якщо його перехоплять —
 *     видалити файли чи переглянути їх список ним неможливо.
 *
 *     Чому не "гнати файл через сервер": у serverless-функцій є стеля на
 *     розмір тіла запиту (~4.5 МБ), і картинки NFT у неї впруться.
 *     З тимчасовим ключем файл іде напряму в Pinata, повз це обмеження.
 *
 *  2) ЗАВАНТАЖЕННЯ У FILEBASE (без action — стара поведінка, не змінювалась)
 *     Filebase повертає CID у нестандартному заголовку (x-amz-meta-cid),
 *     який браузер може заблокувати через CORS — сервер такого обмеження не має.
 *
 * Налаштування (Vercel -> Settings -> Environment Variables), НЕ у коді:
 *   PINATA_MASTER_JWT                                         — головний ключ Pinata (Admin)
 *   SUPABASE_URL / SUPABASE_SERVICE_KEY                       — для обліку лімітів
 *   FILEBASE_TOKENS_ACCESS_KEY / FILEBASE_TOKENS_SECRET_KEY   — акаунт №1 (токени)
 *   FILEBASE_NFT_ACCESS_KEY    / FILEBASE_NFT_SECRET_KEY      — акаунт №2 (NFT Studio)
 *
 * Потрібна таблиця у Supabase: pinata_key_log (SQL — у супровідній інструкції).
 */

const crypto = require('crypto');
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');

const ENDPOINT_HOST = 's3.filebase.com'; // офіційний, стабільний S3-ендпоінт Filebase
const REGION = 'us-east-1';
const SERVICE = 's3';

// Гаманець власника працює без обмежень у кожній функції на кожній мережі.
const OWNER_WALLET = '0xc85b148f3ebd09e9072706166b4cd99cf7ed3108';

const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000; // підпис живе 5 хвилин
const MAX_USES_PER_KEY = 50;                // стеля використань одного ключа
const DAILY_USES_PER_WALLET = 1500;         // денний бюджет на гаманець
const ALLOWED_PURPOSES = ['general', 'litvm', 'tokens'];

// ═══════════════════ Filebase (AWS SigV4) ═══════════════════

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

// ═══════════════════ Видача ключів Pinata ═══════════════════

/**
 * Перевіряє, що запит справді підписаний власником гаманця і що підпис свіжий.
 * Текст повідомлення мусить збігатися з фронтендом до символу.
 */
function verifyWalletSignature(wallet, ts, signature) {
  if (!wallet || !ts || !signature) return { ok: false, error: 'Missing wallet, ts or signature' };

  const age = Date.now() - Number(ts);
  if (!Number.isFinite(age)) return { ok: false, error: 'Bad timestamp' };
  // Невеликий запас уперед — годинники клієнтів розходяться.
  if (age > MAX_SIGNATURE_AGE_MS || age < -60 * 1000) {
    return { ok: false, error: 'Signature expired, please retry' };
  }

  const expectedMsg = 'OpenGate Pinata upload ' + String(wallet).toLowerCase() + ' ' + ts;
  let recovered;
  try {
    recovered = ethers.verifyMessage(expectedMsg, signature).toLowerCase();
  } catch (e) {
    return { ok: false, error: 'Bad signature' };
  }
  if (recovered !== String(wallet).toLowerCase()) {
    return { ok: false, error: 'Signature does not match wallet' };
  }
  return { ok: true };
}

/**
 * Скільки завантажень цей гаманець витратив за добу. Рахуємо саме
 * використання, а не кількість ключів — інакше можна було б узяти один ключ
 * на 50 завантажень і обійти ліміт.
 */
async function usesLastDay(supabase, wallet) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('pinata_key_log')
    .select('uses')
    .eq('wallet', wallet)
    .gte('created_at', since);
  if (error) throw new Error('Rate-limit check failed: ' + error.message);
  return (data || []).reduce((sum, row) => sum + (row.uses || 0), 0);
}

async function handlePinataKey(req, res) {
  const masterJwt = process.env.PINATA_MASTER_JWT;
  if (!masterJwt) {
    res.status(500).json({ error: 'Pinata master key is not configured on the server' });
    return;
  }

  const { wallet, ts, signature, purpose, uses } = req.body || {};

  const sig = verifyWalletSignature(wallet, ts, signature);
  if (!sig.ok) { res.status(401).json({ error: sig.error }); return; }

  const walletLc = String(wallet).toLowerCase();
  const isOwner = walletLc === OWNER_WALLET;

  const purposeTag = ALLOWED_PURPOSES.includes(purpose) ? purpose : 'general';
  let wantUses = parseInt(uses, 10);
  if (!Number.isFinite(wantUses) || wantUses < 1) wantUses = 1;
  if (wantUses > MAX_USES_PER_KEY) wantUses = MAX_USES_PER_KEY;

  // Власника не обмежуємо взагалі й у журнал не пишемо.
  let supabase = null;
  if (!isOwner) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      res.status(500).json({ error: 'Supabase is not configured on the server' });
      return;
    }
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    let spent;
    try {
      spent = await usesLastDay(supabase, walletLc);
    } catch (e) {
      res.status(500).json({ error: e.message });
      return;
    }
    if (spent + wantUses > DAILY_USES_PER_WALLET) {
      res.status(429).json({
        error: 'Daily upload limit reached for this wallet. Try again tomorrow.',
        spent,
        limit: DAILY_USES_PER_WALLET,
      });
      return;
    }
  }

  // Права навмисно урізані: лише завантаження. Видалення (unpin) і перегляд
  // списку файлів заборонені, тому вкрадений ключ нічого не зруйнує.
  const keyRestrictions = {
    keyName: 'og-' + purposeTag + '-' + Date.now(),
    maxUses: wantUses,
    permissions: {
      endpoints: {
        data: { pinList: false, userPinnedDataTotal: false },
        pinning: {
          pinFileToIPFS: true,
          pinJSONToIPFS: true,
          pinJobs: false,
          unpin: false,
          userPinPolicy: false,
        },
      },
    },
  };

  let upstream, json;
  try {
    upstream = await fetch('https://api.pinata.cloud/users/generateApiKey', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: 'Bearer ' + masterJwt,
      },
      body: JSON.stringify(keyRestrictions),
    });
    json = await upstream.json().catch(() => ({}));
  } catch (e) {
    res.status(502).json({ error: 'Could not reach Pinata: ' + (e.message || 'unknown') });
    return;
  }

  if (!upstream.ok || !json.JWT) {
    res.status(502).json({ error: 'Pinata refused to issue a key: ' + upstream.status });
    return;
  }

  // Пишемо у журнал ПІСЛЯ успішної видачі — щоб невдалі спроби не з'їдали ліміт.
  if (!isOwner) {
    const { error } = await supabase
      .from('pinata_key_log')
      .insert({ wallet: walletLc, uses: wantUses, purpose: purposeTag });
    if (error) {
      res.status(500).json({ error: 'Could not record usage, please retry' });
      return;
    }
  }

  res.status(200).json({ jwt: json.JWT, uses: wantUses });
}

// ═══════════════════ Завантаження у Filebase ═══════════════════

async function handleFilebaseUpload(req, res) {
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

  const { amzDate, authHeader } = signRequest({
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
}

// ═══════════════════ Маршрутизація ═══════════════════

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST' }); return; }

  try {
    if ((req.body || {}).action === 'pinataKey') {
      await handlePinataKey(req, res);
      return;
    }
    await handleFilebaseUpload(req, res);
  } catch (e) {
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
};
