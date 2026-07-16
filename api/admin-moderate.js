/**
 * OpenGate Admin Moderation endpoint.
 * File: api/admin-moderate.js
 *
 * Owner-only actions: delete any post, ban/unban a wallet (hides all
 * their posts + NFT marketplace listings across every chain instantly),
 * or hide one specific NFT listing.
 *
 * This app has no Supabase Auth — every visitor shares the same public
 * anon key — so a client-side "if (isOwner)" check alone can't be
 * trusted by the database; anyone could call the same request from
 * devtools. Every action here is gated by a wallet-SIGNED message that
 * this endpoint verifies BEFORE using the service-role key (which
 * bypasses RLS) to actually touch anything — the same pattern the
 * Battleship oracle uses to verify a move before paying out.
 *
 * NFT listings themselves live on-chain and can't be deleted or
 * unlocked from here (that would need an admin-cancel function on an
 * already-deployed marketplace contract, which isn't something a
 * backend endpoint can add). What "hiding" a listing does is make it
 * invisible in OpenGate's own marketplace UI immediately, on every
 * chain, without touching the blockchain — the practical equivalent of
 * banning a wallet's posts.
 */

const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');

const OWNER_WALLET = '0xc85b148f3ebd09e9072706166b4cd99cf7ed3108';
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000; // 5 minutes

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, wallet, signature, ts, postId, targetWallet, network, contractAddr, tokenId, listingId } = req.body || {};

  if (!action || !wallet || !signature || !ts) {
    return res.status(400).json({ error: 'Missing params' });
  }
  if (String(wallet).toLowerCase() !== OWNER_WALLET) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  if (Date.now() - Number(ts) > MAX_SIGNATURE_AGE_MS) {
    return res.status(400).json({ error: 'Signature expired — try the action again' });
  }

  // Reconstruct the exact message the frontend must have signed, and
  // verify the signature actually comes from the owner wallet — this is
  // the one check that makes the whole endpoint safe to expose publicly.
  const target = postId || targetWallet || listingId || '';
  const expectedMsg = 'OpenGate Admin: ' + action + ' ' + target + ' at ' + ts;
  let signer;
  try {
    signer = ethers.verifyMessage(expectedMsg, signature).toLowerCase();
  } catch (e) {
    return res.status(401).json({ error: 'Bad signature' });
  }
  if (signer !== OWNER_WALLET) {
    return res.status(401).json({ error: 'Signature does not match owner wallet' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    if (action === 'deletePost') {
      if (!postId) return res.status(400).json({ error: 'Missing postId' });
      await supabase.from('likes').delete().eq('post_id', postId);
      const { error } = await supabase.from('posts').delete().eq('id', postId);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    if (action === 'banWallet') {
      if (!targetWallet) return res.status(400).json({ error: 'Missing targetWallet' });
      const w = String(targetWallet).toLowerCase();
      const { error } = await supabase
        .from('banned_wallets')
        .upsert({ wallet: w, banned_at: new Date().toISOString() });
      if (error) throw error;

      // Clean up their existing posts immediately too, not just hide
      // future ones.
      const { data: posts } = await supabase.from('posts').select('id').eq('author_wallet', w);
      if (posts && posts.length) {
        const ids = posts.map(p => p.id);
        await supabase.from('likes').delete().in('post_id', ids);
        await supabase.from('posts').delete().in('id', ids);
      }
      return res.status(200).json({ success: true });
    }

    if (action === 'unbanWallet') {
      if (!targetWallet) return res.status(400).json({ error: 'Missing targetWallet' });
      const { error } = await supabase
        .from('banned_wallets')
        .delete()
        .eq('wallet', String(targetWallet).toLowerCase());
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    if (action === 'hideNFTListing') {
      if (!network || !contractAddr || tokenId === undefined || tokenId === null) {
        return res.status(400).json({ error: 'Missing network/contractAddr/tokenId' });
      }
      const { error } = await supabase.from('hidden_nfts').upsert({
        network,
        contract_addr: String(contractAddr).toLowerCase(),
        token_id: String(tokenId),
        listing_id: listingId ? String(listingId) : null,
        hidden_at: new Date().toISOString()
      }, { onConflict: 'network,contract_addr,token_id' });
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('[Admin Moderate Error]', err);
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
};
