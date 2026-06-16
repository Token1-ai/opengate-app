export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await sleep(500 * attempt);
      
      const response = await fetch('https://liteforge.rpc.caldera.xyz/http', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'OpenGate/1.0'
        },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(8000)
      });
      
      const data = await response.json();
      
      if (data.error && data.error.code === -32005 && attempt < 2) {
        continue;
      }
      
      res.status(200).json(data);
      return;
    } catch (e) {
      if (attempt === 2) {
        res.status(500).json({ error: e.message });
      }
    }
  }
}
