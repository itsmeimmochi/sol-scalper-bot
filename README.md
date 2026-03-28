# Sol Scalper Bot 🤖

A Solana scalping bot using **Bollinger Band Mean Reversion** strategy.

## Strategy

- **Timeframe**: 1-hour candles (from CoinGecko free API)
- **Indicators**: Bollinger Bands (20, 2.0) + RSI (14)
- **Buy**: Close ≤ Lower BB **AND** RSI < 38
- **Sell**: Close ≥ Middle BB (SMA) **OR** RSI > 65 **OR** Stop-loss **OR** Take-profit

## Token Universe

SOL, JUP, RAY, ORCA, JTO, PYTH, BONK, WIF

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Generate a wallet

```bash
node bot.js --generate-wallet
```

Fund the generated wallet with:
- **SOL** for transaction fees (~0.05 SOL is enough to start)
- **USDC** for trading (at least `positionSizeUsdc × maxOpenPositions` = $150 USDC by default)

### 3. Configure

Edit `config.json` to adjust:
- `dryRun`: set to `false` to enable live trading
- `risk.positionSizeUsdc`: position size per trade
- `risk.takeProfitPct` / `risk.stopLossPct`: TP/SL thresholds
- `strategy.*`: indicator parameters

### 4. Set up Telegram alerts (optional)

```bash
export TELEGRAM_BOT_TOKEN="your_bot_token"
export TELEGRAM_CHAT_ID="your_chat_id"
```

### 5. Run the bot

```bash
npm start
```

The bot scans all tokens every 60 minutes.

## Project Structure

```
scalper/
  bot.js               ← Main entry + orchestration loop
  config.json          ← All configurable settings
  wallet.json          ← Keypair (gitignored, generate with --generate-wallet)
  positions.json        ← Live position state (auto-created, gitignored)
  lib/
    market.js          ← CoinGecko fetching + candle building
    indicators.js      ← Pure BB + RSI functions
    signals.js         ← Pure buy/sell signal logic
    executor.js        ← Jupiter swap execution
    positions.js       ← Position tracking (in-memory + disk)
    notify.js          ← Telegram notifications
  test/
    indicators.test.js ← Unit tests for indicators
    signals.test.js    ← Unit tests for signals
```

## Running Tests

```bash
npm test
```

## Dry Run Mode

By default, `dryRun: true` in `config.json`. In dry run mode:
- All trade signals are logged to console
- No actual swaps are executed
- Positions are tracked as if trades happened (at current market price)
- Telegram notifications are sent with `[DRY RUN]` tag

Set `"dryRun": false` to enable live trading.

## Risk Warning

⚠️ **This software is for educational purposes.** Crypto trading involves significant risk of loss. Use at your own risk. Always start with dry run mode and small amounts.

## Architecture Notes

- **Pure functions**: `indicators.js` and `signals.js` have zero side effects — safe to test and reason about
- **Persistence**: Open positions survive restarts via `positions.json`
- **Rate limiting**: 1.5s delay between token scans to respect CoinGecko free tier
- **Error isolation**: Failures on one token don't halt the entire scan loop
