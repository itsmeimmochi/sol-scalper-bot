-- Grants read-only access for the local observer container (or any monitoring client).
-- Run once against the same database the bot uses, as a superuser or DB owner, e.g.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/grant-observer-role.sql
--
-- Before running: pick a strong password and replace CHANGE_ME below.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scalper_observer') THEN
    RAISE EXCEPTION 'Role scalper_observer already exists; drop it first or ALTER ROLE to set password';
  END IF;
  CREATE ROLE scalper_observer WITH LOGIN PASSWORD 'CHANGE_ME';
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO scalper_observer', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO scalper_observer;

GRANT SELECT ON TABLE
  bot_config,
  trades,
  open_positions,
  market_candles_hourly,
  trading_tokens,
  discovered_trading_tokens
TO scalper_observer;

-- Verify (as scalper_observer):
--   psql "postgresql://scalper_observer:CHANGE_ME@host:5432/scalper" -c "\dt"
-- Should list tables read-only; INSERT/UPDATE/DELETE must fail.
