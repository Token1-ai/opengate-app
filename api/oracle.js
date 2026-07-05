/**
 * OpenGate Battleship Oracle — Vercel Serverless Function (v2, SECURITY FIXED)
 * File: api/oracle.js
 *
 * ЩО ВИПРАВЛЕНО порівняно з v1:
 *  1. declareWinner тепер ПЕРЕВІРЯЄ гру: всі 20 клітинок переможеного мають
 *     бути влучені пострілами переможця. Просто записати себе переможцем
 *     у Supabase більше недостатньо.
 *  2. Перевіряється, що гравці в базі збігаються з гравцями на контракті.
 *  3. updateTurn більше НЕ перезаписує current_turn у Supabase числом
 *     (фронтенд зберігає там адресу гаманця — це ламало гру після промаху).
 *  4. Нова дія resetTimer — скидає 5-хвилинний таймер ходу на контракті
 *     (використовується після розстановки кораблів).
 *  5. Всі запити до Supabase фільтрують bet_token IS NULL, щоб не зачепити
 *     тестнет-ігри з таким самим contract_game_id.
 *
 * Env vars у Vercel (Settings → Environment Variables):
 *   ORACLE_PRIVATE_KEY   — приватний ключ oracle-гаманця
 *   BATTLESHIP_CONTRACT  — 0x22597403bFa0982803Be28D070a14b6E45700dc0
 *   ORACLE_SECRET        — opengate-oracle-2026 (має збігатися з фронтендом)
 *   SUPABASE_URL         — https://hgzthbidfdqomuotdocb.supabase.co
 *   SUPABASE_SERVICE_KEY — service role key
 */

const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');

const ABI = [
  'function declareWinner(uint256 gameId, address winner) external',
  'function updateTurn(uint256 gameId, uint8 turn) external',
  'function games(uint256) external view returns (address player1, address player2, uint256 betAmount, uint8 token, uint8 status, address winner, uint256 createdAt, uint256 lastMoveAt, uint8 currentTurn)',
];

const RPC = 'https://bsc-dataseed.binance.org/';
const STATUS_PLAYING = 1;
const SHIP_CELLS = 20; // 4+3+3+2+2+2+1+1+1+1

function parseJSON(str, fallback) {
  try { const v = JSON.parse(str); return v == null ? fallback : v; }
  catch (e) { return fallback; }
}

module.exports = async function handler(req, res) {

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Примітка: цей секрет видно у фронтенд-коді, тож він НЕ є захистом.
  // Реальний захист — верифікація результату гри нижче + SQL-тригер у базі.
  if (req.headers['x-oracle-secret'] !== process.env.ORACLE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { action, gameId, winner, turn } = req.body || {};

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

    // Стан гри на контракті — потрібен для всіх дій
    const onChain = await contract.games(gameId);
    const p1 = onChain.player1.toLowerCase();
    const p2 = onChain.player2.toLowerCase();

    // ── Action: RESET TIMER ────────────────────────────────────────────────
    // Скидає 5-хвилинний таймер ходу (наприклад, після розстановки кораблів),
    // не змінюючи чий зараз хід.
    if (action === 'resetTimer') {
      if (Number(onChain.status) !== STATUS_PLAYING) {
        return res.status(400).json({ error: 'Game not playing on-chain' });
      }
      const cur = Number(onChain.currentTurn) === 2 ? 2 : 1;
      const tx = await contract.updateTurn(gameId, cur, { gasLimit: 120_000 });
      await tx.wait();
      return res.status(200).json({ success: true, tx: tx.hash });
    }

    // ── Action: UPDATE TURN ────────────────────────────────────────────────
    if (action === 'updateTurn') {
      if (turn !== 1 && turn !== 2) {
        return res.status(400).json({ error: 'Invalid turn (must be 1 or 2)' });
      }
      if (Number(onChain.status) !== STATUS_PLAYING) {
        return res.status(400).json({ error: 'Game not playing on-chain' });
      }

      // Гра має існувати і бути активною в базі
      const { data: game, error } = await supabase
        .from('battleship_games')
        .select('id,status')
        .eq('contract_game_id', gameId)
        .is('bet_token', null)          // тільки BNB-ігри
        .maybeSingle();

      if (error || !game || game.status === 'finished') {
        return res.status(404).json({ error: 'Game not found or finished' });
      }

      const tx = await contract.updateTurn(gameId, turn, { gasLimit: 120_000 });
      await tx.wait();

      // ВАЖЛИВО: НЕ чіпаємо current_turn у Supabase — там фронтенд зберігає
      // адресу гаманця. Оновлюємо лише мітку часу.
      await supabase
        .from('battleship_games')
        .update({ last_move_at: new Date().toISOString() })
        .eq('id', game.id);

      return res.status(200).json({ success: true, tx: tx.hash });
    }

    // ── Action: DECLARE WINNER ─────────────────────────────────────────────
    if (action === 'declareWinner') {
      if (!winner || !ethers.isAddress(winner)) {
        return res.status(400).json({ error: 'Invalid winner address' });
      }
      const w = winner.toLowerCase();

      // 1) Гра в базі: завершена, з таким самим переможцем
      const { data: game, error } = await supabase
        .from('battleship_games')
        .select('*')
        .eq('contract_game_id', gameId)
        .is('bet_token', null)          // тільки BNB-ігри
        .eq('status', 'finished')
        .eq('winner_wallet', w)
        .maybeSingle();

      if (error || !game) {
        return res.status(400).json({
          error: 'Game result not found in database',
          detail: error ? error.message : undefined
        });
      }

      // 2) On-chain: гра ще Playing, переможець — один з гравців
      if (Number(onChain.status) !== STATUS_PLAYING) {
        return res.status(400).json({ error: 'Game not in playing status on-chain' });
      }
      if (w !== p1 && w !== p2) {
        return res.status(400).json({ error: 'Winner is not a player in this game' });
      }

      // 3) Гравці в базі мають збігатися з гравцями на контракті
      const dbP1 = (game.player1_wallet || '').toLowerCase();
      const dbP2 = (game.player2_wallet || '').toLowerCase();
      if ((dbP1 && dbP1 !== p1) || (dbP2 && dbP2 !== p2)) {
        return res.status(400).json({ error: 'Database players do not match on-chain players' });
      }

      // 4) ГОЛОВНА ПЕРЕВІРКА: всі клітинки флоту переможеного мають бути влучені
      const winnerIsP1 = (w === dbP1) || (!dbP1 && w === p1);
      const loserBoard  = parseJSON(winnerIsP1 ? game.player2_board : game.player1_board, null);
      const winnerShots = parseJSON(winnerIsP1 ? game.player1_shots : game.player2_shots, {});

      if (!Array.isArray(loserBoard) || loserBoard.length !== SHIP_CELLS) {
        return res.status(400).json({ error: 'Invalid loser board — win not verified' });
      }
      const shotKeys = Object.keys(winnerShots || {});
      if (shotKeys.length > 100 ||
          shotKeys.some(k => !/^\d+$/.test(k) || Number(k) > 99)) {
        return res.status(400).json({ error: 'Invalid shots data' });
      }
      const allSunk = loserBoard.every(c => winnerShots[String(c)] === 'hit');
      if (!allSunk) {
        return res.status(400).json({ error: 'Win not verified: not all enemy ships are sunk' });
      }

      // 5) Виплата
      const tx = await contract.declareWinner(gameId, winner, { gasLimit: 200_000 });
      await tx.wait();

      await supabase
        .from('battleship_games')
        .update({
          oracle_confirmed: true,
          oracle_tx: tx.hash,
          payout_at: new Date().toISOString()
        })
        .eq('id', game.id);

      console.log(`[Oracle] Game ${gameId} — winner ${winner} — tx ${tx.hash}`);
      return res.status(200).json({ success: true, tx: tx.hash });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('[Oracle Error]', err);
    return res.status(500).json({ error: 'Oracle error', detail: err.message });
  }
};
