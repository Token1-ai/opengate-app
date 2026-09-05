/**
 * OpenGate Pass Voucher service — api/pass-voucher.js
 *
 * Solves the cross-chain problem: Gold/Silver Pass NFTs live on BNB
 * Chain, but contracts on other networks (Polygon, and future ones)
 * can't read BNB Chain directly. This endpoint does that check on the
 * server, then signs a short-lived "voucher" the destination contract
 * can verify with pure math (ecrecover) — no cross-chain call needed.
 *
 * Usage (from the frontend):
 *   POST /api/pass-voucher
 *   body: { wallet: "0x...", contractAddress: "0x..." }
 *   -> { tier: 0|1|2, expiry: 1234567890, signature: "0x..." }
 *
 * tier: 0 = no pass, 1 = Silver Pass, 2 = Gold Pass.
 * Voucher is valid for 10 minutes — the destination contract checks
 * this itself, so an old voucher can never be replayed after expiry.
 *
 * Environment variable required (Vercel → Settings → Environment Variables):
 *   ATTESTOR_PRIVATE_KEY — the private key of the attestor wallet
 *   (0x84E3A898DA90419795e3b276A302068845754806). This wallet holds no
 *   funds and never sends transactions — it only signs messages.
 *
 * --- Open-table override (added) -----------------------------------
 * The regular (non-VIP) Battleship tables on Polygon and Base used to
 * require a real Silver/Gold Pass because their contracts enforce
 * `tier >= minPassTier(1)` on-chain via this voucher. Per product
 * decision, those two tables are now open to any connected wallet —
 * so for JUST those two contract addresses we floor the issued tier
 * to 1 (Silver) regardless of actual NFT ownership. Every other
 * contract that asks this endpoint for a voucher (Gold VIP Battleship
 * tables, NFT/launchpad pass discounts, etc.) still gets the wallet's
 * real, on-chain-verified tier — nothing else on the platform is
 * affected.
 * ---------------------------------------------------------------------
 */

const { ethers } = require('ethers');

const GOLD_PASS = '0x4D26Ec2f8edbb3F567953CC7573FF60cA009258c';
const SILVER_PASS = '0xeaDF62931f8ef2Ec546E77fBC5E56F1B3157Af89';
const BNB_RPCS = [
  'https://bsc-dataseed.binance.org/',
  'https://bsc-dataseed1.defibit.io/',
  'https://bsc-dataseed1.ninicoin.io/',
];
const NFT_MIN_ABI = ['function balanceOf(address) view returns(uint256)'];
const VOUCHER_TTL_SECONDS = 600; // 10 minutes

// Regular (non-VIP) Battleship tables that no longer require a real pass.
// Everyone gets at least tier 1 (Silver) for these two contracts only.
const OPEN_BATTLESHIP_CONTRACTS = new Set([
  '0x9e723b339da57f046435239dac168003f90b1b20', // Polygon Battleship (regular table)
  '0xc4844ebdace533d7b98c730ad06af57376ecbf12', // Base Battleship (regular table)
]);

async function getPassTier(wallet) {
  let lastErr;
  for (const rpc of BNB_RPCS) {
    try {
      const provider = new ethers.JsonRpcProvider(rpc);
      const gold = new ethers.Contract(GOLD_PASS, NFT_MIN_ABI, provider);
      const silver = new ethers.Contract(SILVER_PASS, NFT_MIN_ABI, provider);
      const [goldBal, silverBal] = await Promise.all([
        gold.balanceOf(wallet),
        silver.balanceOf(wallet),
      ]);
      if (goldBal > 0n) return 2;
      if (silverBal > 0n) return 1;
      return 0;
    } catch (e) {
      lastErr = e;
      continue; // try next RPC
    }
  }
  throw new Error('Could not reach BNB Chain: ' + (lastErr && lastErr.message));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST' }); return; }

  try {
    const { wallet, contractAddress } = req.body || {};
    if (!wallet || !ethers.isAddress(wallet)) {
      res.status(400).json({ error: 'Missing or invalid wallet address' });
      return;
    }
    if (!contractAddress || !ethers.isAddress(contractAddress)) {
      res.status(400).json({ error: 'Missing or invalid contractAddress' });
      return;
    }

    const privateKey = process.env.ATTESTOR_PRIVATE_KEY;
    if (!privateKey) {
      res.status(500).json({ error: 'Attestor key not configured on the server' });
      return;
    }

    let tier = await getPassTier(wallet);

    // Open-table override: regular Polygon/Base Battleship no longer needs a real pass.
    if (OPEN_BATTLESHIP_CONTRACTS.has(contractAddress.toLowerCase()) && tier < 1) {
      tier = 1;
    }

    const expiry = Math.floor(Date.now() / 1000) + VOUCHER_TTL_SECONDS;

    // Must match EXACTLY what the Solidity contract reconstructs:
    // keccak256(abi.encodePacked(wallet, tier, expiry, contractAddress))
    const messageHash = ethers.solidityPackedKeccak256(
      ['address', 'uint8', 'uint256', 'address'],
      [wallet, tier, expiry, contractAddress]
    );

    const attestorWallet = new ethers.Wallet(privateKey);
    // signMessage adds the standard "\x19Ethereum Signed Message:\n32" prefix
    const signature = await attestorWallet.signMessage(ethers.getBytes(messageHash));

    res.status(200).json({ tier, expiry, signature });
  } catch (e) {
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
};
