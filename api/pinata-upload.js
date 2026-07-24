

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const { name, type, dataBase64 } = req.body || {};
    if (!dataBase64) { res.status(400).json({ error: 'No file' }); return; }

    const buffer = Buffer.from(dataBase64, 'base64');
    if (buffer.length > 10 * 1024 * 1024) { res.status(413).json({ error: 'File too large' }); return; }

    const blob = new Blob([buffer], { type: type || 'application/octet-stream' });
    const fd = new FormData();
    fd.append('file', blob, name || 'upload');

    const r = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.PINATA_JWT },
      body: fd
    });

    if (!r.ok) {
      const t = await r.text();
      res.status(502).json({ error: 'Pinata error', detail: t.slice(0, 200) });
      return;
    }

    const j = await r.json();
    res.status(200).json({ url: 'https://gateway.pinata.cloud/ipfs/' + j.IpfsHash, hash: j.IpfsHash });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Upload failed' });
  }
}
