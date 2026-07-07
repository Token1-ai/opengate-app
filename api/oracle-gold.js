/**
 * OpenGate GOLD Battleship Oracle — v1
 * File: api/oracle-gold.js
 *
 * Окремий ендпоінт для VIP-гри (тільки Gold Pass). Відмінності від api/oracle.js:
 *   - окремий контракт GOLD_CONTRACT (адреса вбудована — нового env не треба);
 *   - НЕМАЄ ліміту ставки (мінімум $0.10 забезпечує сам контракт);
 *   - золоті ігри в БД зберігаються зі зсувом id (GOLD_OFFSET), тому НЕ
 *     конфліктують зі звичайними BNB-іграми у спільній таблиці.
 * Успадковує всі фікси безпеки: claimTimeout без рядка не платить,
 * ідемпотентний повтор виплати, ротація RPC.
 *
 * Env vars (ТІ САМІ, що у звичайного oracle — нічого нового додавати не треба):
 *   ORACLE_PRIVATE_KEY, ORACLE_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY
 *
 * Зміни проти v3:
 *  1. 🔴 ФІКС КРАДІЖКИ: claimTimeout без рядка в БД більше НЕ платить.
 *     (Стара логіка рахувала 5 хв від створення КІМНАТИ on-chain — творець
 *      кімнати, що провисіла в лобі 5+ хв, міг забрати ставку суперника
 *      в ту ж секунду після приєднання. Тепер: спочатку розстав кораблі —
 *      це створює рядок у БД, і таймер іде від серверного created_at.)
 *  2. 🟠 Ідемпотентний повтор виплати: якщо транзакція вже пройшла on-chain,
 *     а база не оновилась (обрив/таймаут) — повторний виклик синхронізує БД
 *     і повертає success замість вічного "Game not in playing status".
 *  3. 🟡 Ротація 4 BSC RPC (як у фронтенді) + maxDuration 60с для Vercel.
 *  4. 🟡 Виплата по таймауту тепер пише winner_wallet у БД.
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

// Ротація публічних RPC — якщо один лагає, наступний виклик піде на інший
// ── КОНФІГ ЗОЛОТОЇ ГРИ ──
const GOLD_CONTRACT = '0x79c8d1cE862f51a98f3caCfee43Cc2454839D2F8'; // BattleshipGoldBNB
const GOLD_OFFSET   = 2000000000; // зсув id золотих ігор у БД

const RPCS = [
  'https://bsc-dataseed.binance.org/',
  'https://bsc-dataseed1.defibit.io/',
  'https://bsc-dataseed1.ninicoin.io/',
  'https://bsc-dataseed2.binance.org/',
];
const STATUS_PLAYING  = 1;
const STATUS_FINISHED = 2;
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
  // У БД золоті ігри лежать зі зсувом (on-chain gameId лишається без зсуву)
  const DB_GID = GOLD_OFFSET + Number(gameId);

  try {
    const rpc      = RPCS[Math.floor(Math.random() * RPCS.length)];
    const provider = new ethers.JsonRpcProvider(rpc);
    const wallet   = new ethers.Wallet(process.env.ORACLE_PRIVATE_KEY, provider);
    const contract = new ethers.Contract(GOLD_CONTRACT, ABI, wallet);

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Читаємо гру on-chain (пробуємо формат v4, потім v3)
    let onChain;
    try {
      onChain = await (new ethers.Contract(GOLD_CONTRACT, ABI_V4_GAME, provider)).getGame(gameId);
    } catch (e) {
      onChain = await (new ethers.Contract(GOLD_CONTRACT, ABI_V3_GAME, provider)).games(gameId);
    }
    const p1 = onChain.player1.toLowerCase();
    const p2 = onChain.player2.toLowerCase();
    const onChainWinner = (onChain.winner || ethers.ZeroAddress).toLowerCase();

    // ІДЕМПОТЕНТНІСТЬ: транзакція вже пройшла on-chain, а база могла не
    // оновитись (обрив мережі / таймаут Vercel). Синхронізуємо і кажемо success.
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
      console.log(`[Oracle] Game ${gameId} — already paid on-chain to ${addr}, DB synced`);
      return { success: true, alreadyPaid: true };
    }

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
        .eq('contract_game_id', DB_GID)
        .is('bet_token', null)
        .eq('status', 'finished')
        .eq('winner_wallet', w)
        .maybeSingle();

      if (error || !game) {
        return res.status(400).json({ error: 'Game result not found in database', detail: error ? error.message : undefined });
      }

      // Повторний запит після успішної виплати → синхронізуємо БД
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

      // Головна перевірка: всі клітинки переможеного влучені.
      // Дошки живуть у закритій таблиці battleship_boards (анти-чит);
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

      if (c !== p1 && c !== p2) {
        return res.status(400).json({ error: 'Claimer is not a player in this game' });
      }

      // Повторний запит після успішної виплати → синхронізуємо БД
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
        // 🔴 SECURITY FIX (v4): раніше тут була виплата "першому, хто прийшов"
        // з таймером від створення КІМНАТИ on-chain. Кімната, що провисіла
        // в лобі 5+ хвилин, дозволяла творцю вкрасти ставку суперника одразу
        // після приєднання. Тепер: без рядка в БД виплат НЕМАЄ.
        // Розстав кораблі — це створить рядок, і чесний 5-хвилинний таймер
        // піде від серверного created_at (гарантовано ПІСЛЯ приєднання).
        return res.status(400).json({ error: 'Place your ships first — this starts the AFK timer' });
      }

      if (!game.player1_board || !game.player2_board) {
        // Суперник не розставив кораблі → 5 хв від створення рядка гри
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

      const hash = await payout(claimer, game.id, { status: 'finished', winner_wallet: c });
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

// Vercel: даємо функції до 60с — tx.wait() на BSC інколи довший за дефолтні 10с
module.exports.config = { maxDuration: 60 };
