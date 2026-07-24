import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

const V6 = typeof ethers.JsonRpcProvider === 'function';
const mkProvider = u => V6 ? new ethers.JsonRpcProvider(u) : new ethers.providers.JsonRpcProvider(u);
const isAddr = a => V6 ? ethers.isAddress(a) : ethers.utils.isAddress(a);
const ZERO = '0x0000000000000000000000000000000000000000';

const LAUNCHPAD = '0x24DB137722507515E28A295717b73bB074192931';
const RPCS = [
  'https://bsc-dataseed.binance.org/',
  'https://bsc-dataseed1.defibit.io/',
  'https://bsc-dataseed1.ninicoin.io/'
];
const ABI = ['function getCurve(address) view returns (address creator,uint256 realBNB,uint256 tokensSold,bool graduated,uint256 createdAt)'];

const clip = (s, n) => String(s || '').slice(0, n);
const safeUrl = s => { const v = clip(s, 200).trim(); return /^https?:\/\//i.test(v) ? v : ''; };

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const { tokenAddress, wallet, meta } = req.body || {};
    if (!tokenAddress || !wallet || !meta) { res.status(400).json({ error: 'Missing params' }); return; }
    if (!isAddr(tokenAddress) || !isAddr(wallet)) { res.status(400).json({ error: 'Bad address' }); return; }

    let creator = null;
    for (const url of RPCS) {
      try {
        const lp = new ethers.Contract(LAUNCHPAD, ABI, mkProvider(url));
        const c = await lp.getCurve(tokenAddress);
        creator = c[0];
        break;
      } catch (e) {}
    }
    if (!creator || creator === ZERO) { res.status(404).json({ error: 'Token not found' }); return; }
    if (creator.toLowerCase() !== wallet.toLowerCase()) { res.status(403).json({ error: 'Not token creator' }); return; }

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: ex } = await sb.from('launchpad_tokens').select('creator').eq('address', tokenAddress.toLowerCase()).maybeSingle();
    if (ex && ex.creator && ex.creator.toLowerCase() !== wallet.toLowerCase()) {
      res.status(403).json({ error: 'Already owned' }); return;
    }

    const { error } = await sb.from('launchpad_tokens').upsert({
      address: tokenAddress.toLowerCase(),
      creator: wallet.toLowerCase(),
      chain: 'bnb',
      name: clip(meta.name, 64),
      symbol: clip(meta.symbol, 16),
      description: clip(meta.description, 500),
      image_url: safeUrl(meta.image_url),
      twitter: safeUrl(meta.twitter),
      telegram: safeUrl(meta.telegram),
      website: safeUrl(meta.website)
    }, { onConflict: 'address' });
    if (error) { res.status(500).json({ error: error.message }); return; }

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed' });
  }
}
