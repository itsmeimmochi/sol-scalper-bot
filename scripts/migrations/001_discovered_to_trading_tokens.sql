-- Merge legacy discovered_trading_tokens into trading_tokens.
-- Idempotent: safe to re-run SQL; applied once via schema_migrations.
-- Does not change enabled on existing trading_tokens rows (ON CONFLICT omits enabled).

INSERT INTO trading_tokens (symbol, gecko_id, mint, enabled, sort_order, updated_at)
SELECT symbol, gecko_id, mint, enabled, sort_order, updated_at
FROM discovered_trading_tokens
ON CONFLICT (symbol) DO UPDATE SET
  gecko_id = EXCLUDED.gecko_id,
  mint = EXCLUDED.mint,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();
