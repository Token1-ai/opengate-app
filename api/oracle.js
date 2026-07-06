/**
 * OpenGate Battleship Oracle — v3 (МАСШТАБОВАНИЙ)
 * File: api/oracle.js
 *
 * Ключова зміна: oracle робить лише 1 транзакцію на гру.
 *  - declareWinner — виплата переможцю (всі кораблі потоплені, перевіряється)
 *  - claimTimeout  — суперник AFK 5+ хвилин → переможець отримує банк
 *    (перевірка AFK по базі, без жодних щоходових транзакцій)
 *
 * updateTurn / resetTimer залишені для сумісності зі старим контрактом v3,
 * але новий фронтенд їх більше не викликає.
 *
 * Env vars у Vercel:
 *   ORACLE_PRIVATE_KEY, BATTLESHIP_CONTRACT (адреса v4!), ORACLE_SECRET,
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');

const ABI = [
  'function declareWinner(uint256 gameId, address winner) external',
  'function updateTurn(uint256 gameId, uint8 turn) external',
];
const ABI_V4_GAME = [
  'function getGame(uint256) external view returns (tuple(address player1,address player2,uint256 betAmount,uint8 token,uint8 status,address winner,uint256 createdAt))',
];
const ABI_V3_GAME = [
  'function games(uint256) external view returns (address player1, address player2, uint256 betAmount, uint8 token, uint8 status, address winner, uint256 createdAt, uint256 lastMoveAt, uint8 currentTurn)',
];

const RPC = 'https://bsc-dataseed.binance.org/';
const STATUS_PLAYING = 1;
const SHIP_CELLS = 20;
const AFK_MS = 5 * 60 * 1000; // 5 хвилин

function parseJSON(str, fallback) {
  try { const v = JSON.parse(str); return v == null ? fallback : v; }
  catch (e) { return fallback; }
}

module.exports = async function handler(req, res) {

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (req.headers['x-oracle-secret'] !== process.env.ORACLE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { action, gameId, winner, claimer, turn } = req.body || {};

  if (!gameId || !Number.isInteger(Number(gameId)) || Number(gameId) <= 0) {
    return res.status(400).json({ error: 'Missing or invalid gameId' });
  }

  try {
    const provider = new ethers.JsonRpcProvider(RPC);
    const wallet   = new ethers.Wallet(process.env.ORACLE_PRIVATE_KEY, provider);
    const contract = new ethers.Contract(process.env.BATTLESHIP_CONTRACT, ABI, wallet);

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Читаємо гру on-chain (пробуємо формат v4, потім v3)
    let onChain;
    try {
      onChain = await (new ethers.Contract(process.env.BATTLESHIP_CONTRACT, ABI_V4_GAME, provider)).getGame(gameId);
    } catch (e) {
      onChain = await (new ethers.Contract(process.env.BATTLESHIP_CONTRACT, ABI_V3_GAME, provider)).games(gameId);
    }
    const p1 = onChain.player1.toLowerCase();
    const p2 = onChain.player2.toLowerCase();

    // Виплата + оновлення бази
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
      console.log(`[Oracle] Game ${gameId} — winner ${winnerAddr} — tx ${tx.hash}`);
      return tx.hash;
    }

    // ── Action: DECLARE WINNER (всі кораблі потоплені) ──────────────────────
    if (action === 'declareWinner') {
      if (!winner || !ethers.isAddress(winner)) {
        return res.status(400).json({ error: 'Invalid winner address' });
      }
      const w = winner.toLowerCase();

      const { data: game, error } = await supabase
        .from('battleship_games')
        .select('*')
        .eq('contract_game_id', gameId)
        .is('bet_token', null)
        .eq('status', 'finished')
        .eq('winner_wallet', w)
        .maybeSingle();

      if (error || !game) {
        return res.status(400).json({ error: 'Game result not found in database', detail: error ? error.message : undefined });
      }
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

      // Головна перевірка: всі клітинки переможеного влучені.
      // Дошки тепер живуть у закритій таблиці battleship_boards (анти-чит);
      // для старих ігор — fallback на колонки головного рядка.
      const winnerIsP1  = w === p1;
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

    // ── Action: CLAIM TIMEOUT (суперник AFK 5+ хвилин) ──────────────────────
    if (action === 'claimTimeout') {
      if (!claimer || !ethers.isAddress(claimer)) {
        return res.status(400).json({ error: 'Invalid claimer address' });
      }
      const c = claimer.toLowerCase();

      if (Number(onChain.status) !== STATUS_PLAYING) {
        return res.status(400).json({ error: 'Game not in playing status on-chain' });
      }
      if (c !== p1 && c !== p2) {
        return res.status(400).json({ error: 'Claimer is not a player in this game' });
      }

      const { data: game, error } = await supabase
        .from('battleship_games')
        .select('*')
        .eq('contract_game_id', gameId)
        .is('bet_token', null)
        .maybeSingle();

      if (game && game.status === 'finished') {
        return res.status(400).json({ error: 'Game already finished in database' });
      }

      if (!game) {
        // Рядка ще нема — ніхто не розставив кораблі. 5 хв від створення on-chain.
        const createdMs = Number(onChain.createdAt) * 1000;
        if (Date.now() - createdMs < AFK_MS) {
          return res.status(400).json({ error: 'Opponent still has time' });
        }
        // Без рядка не знаємо, хто реально грав — платимо claimer'у
        // (обидва бездіяли; перший, хто прийшов, забирає)
        const tx = await contract.declareWinner(gameId, claimer, { gasLimit: 250_000 });
        await tx.wait();
        console.log(`[Oracle] Game ${gameId} — timeout (no db row) — winner ${claimer} — tx ${tx.hash}`);
        return res.status(200).json({ success: true, tx: tx.hash });
      }

      if (!game.player1_board || !game.player2_board) {
        // Суперник не розставив кораблі → 5 хв від створення гри
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
        // Бій іде: зараз має бути хід СУПЕРНИКА і тиша 5+ хвилин
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

      const hash = await payout(claimer, game.id, { status: 'finished' });
      return res.status(200).json({ success: true, tx: hash });
    }

    // ── Сумісність зі старим контрактом v3 (новий фронтенд не викликає) ─────
    if (action === 'updateTurn' || action === 'resetTimer') {
      let t = turn;
      if (action === 'resetTimer') t = Number(onChain.currentTurn || 1) === 2 ? 2 : 1;
      if (t !== 1 && t !== 2) return res.status(400).json({ error: 'Invalid turn' });
      const tx = await contract.updateTurn(gameId, t, { gasLimit: 120_000 });
      await tx.wait();
      return res.status(200).json({ success: true, tx: tx.hash });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('[Oracle Error]', err);
    return res.status(500).json({ error: 'Oracle error', detail: err.message });
  }
};
