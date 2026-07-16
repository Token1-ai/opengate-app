/**
 * OpenGate Battleship Oracle — Polygon Gold VIP table
 * File: api/oracle-gold-polygon.js
 *
 * Same design as api/oracle.js (BNB), adapted for BattleshipPolygon.sol:
 *   - getGame(gameId) returns one struct (player1, player2, betAmount,
 *     paymentToken, status, winner, createdAt) instead of the two BNB
 *     ABI shapes — this contract only ever had one version, so there's
 *     no v3/v4 fallback needed.
 *   - Status enum: 0=None, 1=Waiting, 2=Playing, 3=Finished, 4=Cancelled
 *     (BNB uses 1=Playing, 2=Finished — DIFFERENT numbering, don't mix
 *     up STATUS_PLAYING/STATUS_FINISHED between the two files).
 *   - Games are stored in the SAME shared `battleship_games` table as
 *     BNB, offset by POLYGON_GOLD_OFFSET so contract_game_id ranges never
 *     collide with BNB regular (no offset) or BNB Gold (2,000,000,000).
 *   - Inherits the same security fixes as oracle.js: claimTimeout without
 *     a DB row never pays out, idempotent payout retry, rotating RPC
 *     pool (using the Polygon pool, not BSC's).
 *
 * Env vars in Vercel (shared with everything else, nothing new to add):
 *   ORACLE_PRIVATE_KEY, ORACLE_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY
 *
 * NOTE: ORACLE_PRIVATE_KEY is the SAME wallet used on BNB — a private
 * key works identically on any EVM chain, so no new key was needed;
 * that wallet just also needs a small POL balance for Polygon gas.
 */

const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');

const BATTLESHIP_CONTRACT = '0xb08A26CCEFbD2cB2194E8b9894E5DfC1D413aDC6'; // Gold VIP table

const ABI = [
  'function declareWinner(uint256 gameId, address winner) external',
  'function getGame(uint256) external view returns (tuple(address player1,address player2,uint256 betAmount,address paymentToken,uint8 status,address winner,uint256 createdAt))',
];

// Same rotating-pool pattern used everywhere else on Polygon — a single
// public RPC (like the now-deprecated polygon-rpc.com) can 401/rate-limit
// under load.
const RPCS = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://polygon.drpc.org',
  'https://rpc.ankr.com/polygon'
];

const STATUS_PLAYING  = 2; // Playing, per this contract's enum (NOT 1 — that's BNB's numbering)
const STATUS_FINISHED = 3; // Finished
const SHIP_CELLS = 20;
const AFK_MS = 5 * 60 * 1000; // 5 minutes, same as BNB

const POLYGON_GOLD_OFFSET = 4000000000; // keeps this table's DB ids out of BNB's ranges (0 and 2,000,000,000)

function parseJSON(str, fallback) {
  try { const v = JSON.parse(str); return v == null ? fallback : v; }
  catch (e) { return fallback; }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('RPC timeout ' + ms + 'ms')), ms))
  ]);
}

async function getWorkingProvider() {
  // Try each RPC once; return the first that answers. Each attempt is
  // capped so a hanging/overloaded node can't stall the whole payout —
  // this matters more here than anywhere else, since this is the path
  // that actually pays out a winner's prize money.
  for (const rpc of RPCS.sort(() => Math.random() - 0.5)) {
    try {
      const p = new ethers.JsonRpcProvider(rpc);
      await withTimeout(p.getBlockNumber(), 8000);
      return p;
    } catch (e) { /* try next */ }
  }
  throw new Error('All Polygon RPCs failed');
}

module.exports = async function handler(req, res) {

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (req.headers['x-oracle-secret'] !== process.env.ORACLE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { action, gameId, winner, claimer } = req.body || {};

  if (!Number.isInteger(Number(gameId)) || Number(gameId) < 0) {
    return res.status(400).json({ error: 'Missing or invalid gameId' });
  }
  const DB_GID = POLYGON_GOLD_OFFSET + Number(gameId);

  try {
    const provider = await getWorkingProvider();
    const wallet   = new ethers.Wallet(process.env.ORACLE_PRIVATE_KEY, provider);
    const contract = new ethers.Contract(BATTLESHIP_CONTRACT, ABI, wallet);

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const onChain = await (new ethers.Contract(BATTLESHIP_CONTRACT, ABI, provider)).getGame(gameId);
    const p1 = onChain.player1.toLowerCase();
    const p2 = onChain.player2.toLowerCase();
    const onChainWinner = (onChain.winner || ethers.ZeroAddress).toLowerCase();

    // IDEMPOTENCY: the tx may already have gone through on-chain even if
    // the DB update never landed (network blip / Vercel timeout).
    async function syncIfAlreadyPaid(addr) {
      if (Number(onChain.status) !== STATUS_FINISHED) return null;
      if (onChainWinner !== addr) return null;
      await supabase
        .from('battleship_games')
        .update({
          status: 'finished',
          winner_wallet: addr,
          oracle_confirmed: true,
          payout_at: new Date().toISOString()
        })
        .eq('contract_game_id', DB_GID)
        .is('bet_token', null);
      return { success: true, alreadyPaid: true };
    }

    async function payout(winnerAddr, dbRowId, extraUpdate) {
      const tx = await contract.declareWinner(gameId, winnerAddr, { gasLimit: 250_000 });
      await tx.wait();
      await supabase
        .from('battleship_games')
        .update(Object.assign({
          oracle_confirmed: true,
          oracle_tx: tx.hash,
          payout_at: new Date().toISOString()
        }, extraUpdate || {}))
        .eq('id', dbRowId);
      return tx.hash;
    }

    // ── Action: DECLARE WINNER (all enemy ships sunk) ──────────────────
    if (action === 'declareWinner') {
      if (!winner || !ethers.isAddress(winner)) {
        return res.status(400).json({ error: 'Invalid winner address' });
      }
      const w = winner.toLowerCase();

      const { data: game, error } = await supabase
        .from('battleship_games')
        .select('*')
        .eq('contract_game_id', DB_GID)
        .is('bet_token', null)
        .eq('status', 'finished')
        .eq('winner_wallet', w)
        .maybeSingle();

      if (error || !game) {
        return res.status(400).json({ error: 'Game result not found in database', detail: error ? error.message : undefined });
      }

      const synced = await syncIfAlreadyPaid(w);
      if (synced) return res.status(200).json(synced);

      if (Number(onChain.status) !== STATUS_PLAYING) {
        return res.status(400).json({ error: 'Game not in playing status on-chain' });
      }
      if (w !== p1 && w !== p2) {
        return res.status(400).json({ error: 'Winner is not a player in this game' });
      }
      const dbP1 = (game.player1_wallet || '').toLowerCase();
      const dbP2 = (game.player2_wallet || '').toLowerCase();
      if ((dbP1 && dbP1 !== p1) || (dbP2 && dbP2 !== p2)) {
        return res.status(400).json({ error: 'Database players do not match on-chain players' });
      }

      // All of the loser's cells must be marked 'hit'. Boards live in the
      // closed battleship_boards table (anti-cheat: no browser access);
      // fall back to the legacy main-row columns for older games.
      const winnerIsP1 = w === p1;
      let boardsRow = null;
      try {
        const br = await supabase.from('battleship_boards').select('*').eq('game_row_id', game.id).maybeSingle();
        boardsRow = br.data || null;
      } catch (e) { /* ignore */ }
      const loserRaw = boardsRow
        ? (winnerIsP1 ? boardsRow.p2_board : boardsRow.p1_board)
        : (winnerIsP1 ? game.player2_board : game.player1_board);
      const loserBoard  = parseJSON(loserRaw, null);
      const winnerShots = parseJSON(winnerIsP1 ? game.player1_shots : game.player2_shots, {});
      if (!Array.isArray(loserBoard) || loserBoard.length !== SHIP_CELLS) {
        return res.status(400).json({ error: 'Invalid loser board — win not verified' });
      }
      const keys = Object.keys(winnerShots || {});
      if (keys.length > 100 || keys.some(k => !/^\d+$/.test(k) || Number(k) > 99)) {
        return res.status(400).json({ error: 'Invalid shots data' });
      }
      const allSunk = loserBoard.every(cell => winnerShots[String(cell)] === 'hit');
      if (!allSunk) {
        return res.status(400).json({ error: 'Win not verified: not all enemy ships are sunk' });
      }

      const hash = await payout(winner, game.id);
      return res.status(200).json({ success: true, tx: hash });
    }

    // ── Action: CLAIM TIMEOUT (opponent AFK 5+ minutes) ─────────────────
    if (action === 'claimTimeout') {
      if (!claimer || !ethers.isAddress(claimer)) {
        return res.status(400).json({ error: 'Invalid claimer address' });
      }
      const c = claimer.toLowerCase();

      if (c !== p1 && c !== p2) {
        return res.status(400).json({ error: 'Claimer is not a player in this game' });
      }

      const synced = await syncIfAlreadyPaid(c);
      if (synced) return res.status(200).json(synced);

      if (Number(onChain.status) !== STATUS_PLAYING) {
        return res.status(400).json({ error: 'Game not in playing status on-chain' });
      }

      const { data: game, error } = await supabase
        .from('battleship_games')
        .select('*')
        .eq('contract_game_id', DB_GID)
        .is('bet_token', null)
        .maybeSingle();

      if (game && game.status === 'finished') {
        return res.status(400).json({ error: 'Game already finished in database' });
      }

      if (!game) {
        // SECURITY: no DB row means no timer has legitimately started —
        // never pay a claim with nothing to back it (same fix as BNB v4).
        return res.status(400).json({ error: 'Place your ships first — this starts the AFK timer' });
      }

      if (!game.player1_board || !game.player2_board) {
        const created = new Date(game.created_at || 0).getTime();
        if (Date.now() - created < AFK_MS) {
          return res.status(400).json({ error: 'Opponent still has time to place ships' });
        }
        const claimerIsP1 = c === p1;
        const myBoard = claimerIsP1 ? game.player1_board : game.player2_board;
        if (!myBoard) {
          return res.status(400).json({ error: 'Place your own ships first' });
        }
      } else {
        const turnWallet = (game.current_turn || '').toLowerCase();
        if (turnWallet === c) {
          return res.status(400).json({ error: 'It is your move — you cannot claim' });
        }
        const lastMove = new Date(game.last_move_at || game.created_at || 0).getTime();
        if (Date.now() - lastMove < AFK_MS) {
          const waitSec = Math.ceil((AFK_MS - (Date.now() - lastMove)) / 1000);
          return res.status(400).json({ error: 'Opponent still has time', detail: waitSec + 's left' });
        }
      }

      const hash = await payout(claimer, game.id, { status: 'finished', winner_wallet: c });
      return res.status(200).json({ success: true, tx: hash });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('[Oracle-Polygon Error]', err);
    return res.status(500).json({ error: 'Oracle error', detail: err.message });
  }
};

module.exports.config = { maxDuration: 60 };
