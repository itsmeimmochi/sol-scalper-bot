/**
 * notify.js — Telegram notifications.
 * Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from environment.
 */

import fetch from 'node-fetch';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

/**
 * Send a message to Telegram.
 * Silently skips if env vars are not configured.
 * @param {string} text
 */
export async function notify(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    // Not configured — just log it
    console.log(`[notify] (no Telegram) ${text}`);
    return;
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`[notify] Telegram error: ${err}`);
    }
  } catch (e) {
    console.error(`[notify] Failed to send Telegram message: ${e.message}`);
  }
}

/**
 * Format a buy notification.
 */
export function buyMessage({ symbol, entryPrice, sizeUsdc, dryRun }) {
  const tag = dryRun ? '🔵 [DRY RUN] ' : '🟢 ';
  return `${tag}BUY <b>${symbol}</b>\nEntry: $${entryPrice.toFixed(6)}\nSize: $${sizeUsdc} USDC`;
}

/**
 * Format a sell notification.
 */
export function sellMessage({ symbol, entryPrice, exitPrice, pnl, reason, dryRun }) {
  const tag = dryRun ? '🔵 [DRY RUN] ' : (pnl >= 0 ? '✅ ' : '🔴 ');
  const pnlStr = pnl >= 0 ? `+${pnl.toFixed(2)}%` : `${pnl.toFixed(2)}%`;
  return `${tag}SELL <b>${symbol}</b>\nEntry: $${entryPrice.toFixed(6)} → Exit: $${exitPrice.toFixed(6)}\nPnL: ${pnlStr} | Reason: ${reason}`;
}

/**
 * Format an error notification.
 */
export function errorMessage(context, err) {
  return `⚠️ <b>Error</b> [${context}]\n${err.message || err}`;
}
