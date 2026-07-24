import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

const V6 = typeof ethers.JsonRpcProvider === 'function';
const mkProvider = u => V6 ? new ethers.JsonRpcProvider(u) : new ethers.providers.JsonRpcProvider(u);
const mkIface = a => V6 ? new ethers.Interface(a) : new ethers.utils.Interface(a);
const fmtEther = v => V6 ? ethers.formatEther(v) : ethers.utils.formatEther(v);

const LAUNCHPAD = '0x24DB137722507515E28A295717b73bB074192931';
const RPCS = [
  'https://bsc-dataseed.binance.org/',
  'https://bsc-dataseed1.defibit.io/',
  'https://bsc-dataseed1.ninicoin.io/'
];
const ABI = [
  'event Buy(address indexed token,address indexed buyer,uint256 bnbIn,uint256 tokensOut,uint256 newPrice)',
  'event Sell(address indexed token,address indexed seller,uint256 tokensIn,uint256 bnbOut,uint256 newPrice)'
];

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const { txHash, tokenAddress, wallet } = req.body || {};
    if (!txHash || !tokenAddress || !wallet) { res.status(400).json({ error: 'Missing params' }); return; }
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) { res.status(400).json({ error: 'Bad tx hash' }); return; }

    let receipt = null;
    for (const url of RPCS) {
      try { receipt = await mkProvider(url).getTransactionReceipt(txHash); if (receipt) break; } catch (e) {}
    }
    if (!receipt) { res.status(404).json({ error: 'Tx not found' }); return; }
    if (Number(receipt.status) !== 1) { res.status(400).json({ error: 'Tx failed' }); return; }
    if (!receipt.to || receipt.to.toLowerCase() !== LAUNCHPAD.toLowerCase()) {
      res.status(400).json({ error: 'Wrong contract' }); return;
    }

    const iface = mkIface(ABI);
    let found = null;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== LAUNCHPAD.toLowerCase()) continue;
      let p; try { p = iface.parseLog(log); } catch (e) { continue; }
      if (!p) continue;
      const tok = String(p.args.token).toLowerCase();
      if (tok !== tokenAddress.toLowerCase()) continue;
      if (p.name === 'Buy' && String(p.args.buyer).toLowerCase() === wallet.toLowerCase()) {
        found = { side: 'buy', bnb: p.args.bnbIn, tokens: p.args.tokensOut, price: p.args.newPrice }; break;
      }
      if (p.name === 'Sell' && String(p.args.seller).toLowerCase() === wallet.toLowerCase()) {
        found = { side: 'sell', bnb: p.args.bnbOut, tokens: p.args.tokensIn, price: p.args.newPrice }; break;
      }
    }
    if (!found) { res.status(400).json({ error: 'No matching trade event' }); return; }

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: existing } = await sb.from('launchpad_trades').select('id').eq('tx_hash', txHash).maybeSingle();
    if (existing) { res.status(200).json({ ok: true, duplicate: true }); return; }

    const { error } = await sb.from('launchpad_trades').insert({
      token_address: tokenAddress.toLowerCase(),
      wallet: wallet.toLowerCase(),
      side: found.side,
      bnb_amount: Number(fmtEther(found.bnb)),
      token_amount: Number(fmtEther(found.tokens)),
      price: Number(fmtEther(found.price)),
      tx_hash: txHash
    });
    if (error) { res.status(500).json({ error: error.message }); return; }

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed' });
  }
}
