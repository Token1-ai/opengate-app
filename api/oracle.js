/**
 * OpenGate Battleship Oracle — Vercel Serverless Function
 * File: api/oracle.js
 *
 * This function is called by the frontend when a game ends.
 * It verifies the game result and calls declareWinner() on the contract.
 *
 * Setup:
 *   1. Add to your GitHub repo in folder /api/oracle.js
 *   2. Set environment variables in Vercel dashboard:
 *      ORACLE_PRIVATE_KEY = private key of oracle wallet
 *      BATTLESHIP_CONTRACT = deployed contract address
 *      SUPABASE_URL = your supabase url
 *      SUPABASE_SERVICE_KEY = service role key (not anon!)
 *
 * Security:
 *   - Verifies game result against Supabase database
 *   - Only callable when game is actually finished
 *   - Oracle wallet address must match contract's oracle address
 */

const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');

// ── Contract ABI (only what we need) ──────────────────────────────────────
const ABI = [
  'function declareWinner(uint256 gameId, address winner) external',
  'function updateTurn(uint256 gameId, uint8 turn) external',
  'function games(uint256) external view returns (address player1, address player2, uint256 betAmount, uint8 token, uint8 status, address winner, uint256 createdAt, uint256 lastMoveAt, uint8 currentTurn)',
];

// ── BNB Chain RPC ──────────────────────────────────────────────────────────
const RPC = 'https://bsc-dataseed.binance.org/';

// ── Main handler ───────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {

  // Only POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Simple auth check — frontend sends a secret header
  const authHeader = req.headers['x-oracle-secret'];
  if (authHeader !== process.env.ORACLE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { action, gameId, winner, turn } = req.body;

  if (!gameId) {
    return res.status(400).json({ error: 'Missing gameId' });
  }

  try {
    // ── Setup ethers ────────────────────────────────────────────────────────
    const provider = new ethers.JsonRpcProvider(RPC);
    const wallet   = new ethers.Wallet(process.env.ORACLE_PRIVATE_KEY, provider);
    const contract = new ethers.Contract(
      process.env.BATTLESHIP_CONTRACT,
      ABI,
      wallet
    );

    // ── Setup Supabase ──────────────────────────────────────────────────────
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY // service key — can read all rows
    );

    // ── Action: UPDATE TURN ─────────────────────────────────────────────────
    if (action === 'updateTurn') {
      if (!turn || (turn !== 1 && turn !== 2)) {
        return res.status(400).json({ error: 'Invalid turn (must be 1 or 2)' });
      }

      // Verify game is still playing in Supabase
      const { data: game, error } = await supabase
        .from('battleship_games')
        .select('*')
        .eq('contract_game_id', gameId)
        .eq('status', 'playing')
        .single();

      if (error || !game) {
        return res.status(404).json({ error: 'Game not found or not playing' });
      }

      // Call contract
      const tx = await contract.updateTurn(gameId, turn, {
        gasLimit: 100_000,
      });
      await tx.wait();

      // Update Supabase
      await supabase
        .from('battleship_games')
        .update({ current_turn: turn, last_move_at: new Date().toISOString() })
        .eq('contract_game_id', gameId);

      return res.status(200).json({ success: true, tx: tx.hash });
    }

    // ── Action: DECLARE WINNER ──────────────────────────────────────────────
    if (action === 'declareWinner') {
      if (!winner || !ethers.isAddress(winner)) {
        return res.status(400).json({ error: 'Invalid winner address' });
      }

      // Verify game result in Supabase
      // The frontend updates Supabase when all ships are sunk
      // Oracle trusts Supabase as source of truth
      const { data: game, error } = await supabase
        .from('battleship_games')
        .select('*')
        .eq('contract_game_id', gameId)
        .eq('status', 'finished')
        .eq('winner_wallet', winner.toLowerCase())
        .single();

      if (error || !game) {
        return res.status(400).json({
          error: 'Game result not verified in database',
          detail: error?.message
        });
      }

      // Double-check on-chain: game must be in Playing status
      const onChainGame = await contract.games(gameId);
      const ON_CHAIN_STATUS_PLAYING = 1;
      if (Number(onChainGame.status) !== ON_CHAIN_STATUS_PLAYING) {
        return res.status(400).json({ error: 'Game not in playing status on-chain' });
      }

      // Verify winner is one of the players
      const p1 = onChainGame.player1.toLowerCase();
      const p2 = onChainGame.player2.toLowerCase();
      if (winner.toLowerCase() !== p1 && winner.toLowerCase() !== p2) {
        return res.status(400).json({ error: 'Winner is not a player in this game' });
      }

      // Call contract — this pays the winner automatically
      const tx = await contract.declareWinner(gameId, winner, {
        gasLimit: 150_000,
      });
      await tx.wait();

      // Update Supabase
      await supabase
        .from('battleship_games')
        .update({
          oracle_confirmed: true,
          oracle_tx: tx.hash,
          payout_at: new Date().toISOString()
        })
        .eq('contract_game_id', gameId);

      console.log(`[Oracle] Game ${gameId} — winner ${winner} — tx ${tx.hash}`);
      return res.status(200).json({ success: true, tx: tx.hash });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('[Oracle Error]', err);
    return res.status(500).json({
      error: 'Oracle error',
      detail: err.message
    });
  }
};
