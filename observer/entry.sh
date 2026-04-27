#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

require_env() {
  local name="$1"
  if [[ -z ${!name:-} ]]; then
    log "[observer] Missing required env: ${name}"
    exit 1
  fi
}

is_digits() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

start_db_tunnel() {
  require_env OBSERVER_SSH_TUNNEL_HOST
  require_env OBSERVER_SSH_TUNNEL_USER
  require_env OBSERVER_SSH_TUNNEL_REMOTE_SPEC
  require_env OBSERVER_TUNNEL_LOCAL_PORT

  local key="${OBSERVER_SSH_TUNNEL_KEY_FILE:-/run/observer/ssh_tunnel_key}"
  if [[ ! -r "$key" ]]; then
    log "[observer] Tunnel key not readable: ${key}"
    exit 1
  fi
  chmod 600 "$key" 2>/dev/null || true

  log "[observer] Starting SSH tunnel 127.0.0.1:${OBSERVER_TUNNEL_LOCAL_PORT} -> ${OBSERVER_SSH_TUNNEL_REMOTE_SPEC} on ${OBSERVER_SSH_TUNNEL_USER}@${OBSERVER_SSH_TUNNEL_HOST}"
  ssh -f -N \
    -o BatchMode=yes \
    -o StrictHostKeyChecking="${OBSERVER_SSH_STRICT_HOST_KEY_CHECKING:-accept-new}" \
    -o ExitOnForwardFailure=yes \
    -i "$key" \
    -p "${OBSERVER_SSH_TUNNEL_PORT:-22}" \
    -L "127.0.0.1:${OBSERVER_TUNNEL_LOCAL_PORT}:${OBSERVER_SSH_TUNNEL_REMOTE_SPEC}" \
    "${OBSERVER_SSH_TUNNEL_USER}@${OBSERVER_SSH_TUNNEL_HOST}"

  sleep 1
}

poll_trades_loop() {
  require_env OBSERVER_DATABASE_URL

  local last_id=0
  while true; do
    if ! raw_max="$(psql "$OBSERVER_DATABASE_URL" -v ON_ERROR_STOP=1 -t -A -c 'SELECT COALESCE(MAX(id), 0)::text FROM trades' 2>&1)"; then
      log "[observer] trades poll error: ${raw_max}"
      sleep "${OBSERVER_POLL_INTERVAL_SECONDS:-30}"
      continue
    fi
    raw_max="$(echo "$raw_max" | tr -d '[:space:]')"
    if ! is_digits "$raw_max"; then
      log "[observer] trades poll unexpected max id: ${raw_max}"
      sleep "${OBSERVER_POLL_INTERVAL_SECONDS:-30}"
      continue
    fi

    if (( raw_max > last_id )); then
      trade_sql="SELECT '[observer][trades] id=' || id::text || ' symbol=' || symbol || ' pnl_usdc=' || pnl_usdc::text || ' won=' || won::text || ' sim=' || is_simulated::text || ' closed_at=' || closed_at::text FROM trades WHERE id > ${last_id} ORDER BY id ASC"
      if ! trade_lines="$(psql "$OBSERVER_DATABASE_URL" -v ON_ERROR_STOP=1 -t -A -c "$trade_sql" 2>&1)"; then
        log "[observer] trades detail poll error: ${trade_lines}"
        sleep "${OBSERVER_POLL_INTERVAL_SECONDS:-30}"
        continue
      fi
      while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        [[ "$line" == '(0 rows)' ]] && continue
        [[ "$line" == *'rows)'* ]] && continue
        log "$line"
      done <<< "$trade_lines"
      last_id="$raw_max"
    fi

    sleep "${OBSERVER_POLL_INTERVAL_SECONDS:-30}"
  done
}

poll_positions_loop() {
  require_env OBSERVER_DATABASE_URL

  while true; do
    pos_sql="SELECT COALESCE('[observer][positions] ' || string_agg(symbol || '@' || entry_price::text || ' sim=' || is_simulated::text, '; ' ORDER BY symbol, is_simulated), '[observer][positions] (none)') FROM open_positions"
    out="$(psql "$OBSERVER_DATABASE_URL" -v ON_ERROR_STOP=1 -t -A -c "$pos_sql" 2>&1)" || {
      log "[observer] positions poll error: ${out}"
      sleep "${OBSERVER_POSITION_POLL_INTERVAL_SECONDS:-60}"
      continue
    }
    log "$out"
    sleep "${OBSERVER_POSITION_POLL_INTERVAL_SECONDS:-60}"
  done
}

poll_config_loop() {
  require_env OBSERVER_DATABASE_URL

  while true; do
    cfg_sql="SELECT '[observer][config] dry_run=' || dry_run::text || ' scan_min=' || COALESCE(scan_interval_minutes::text, 'null') || ' updated_at=' || updated_at::text FROM bot_config WHERE id = 1"
    out="$(psql "$OBSERVER_DATABASE_URL" -v ON_ERROR_STOP=1 -t -A -c "$cfg_sql" 2>&1)" || {
      log "[observer] config poll error: ${out}"
      sleep "${OBSERVER_CONFIG_POLL_INTERVAL_SECONDS:-60}"
      continue
    }
    log "$out"
    sleep "${OBSERVER_CONFIG_POLL_INTERVAL_SECONDS:-60}"
  done
}

stream_remote_logs() {
  require_env OBSERVER_SSH_LOGS_HOST
  require_env OBSERVER_SSH_LOGS_USER
  require_env OBSERVER_SSH_LOGS_KEY_FILE

  local key="$OBSERVER_SSH_LOGS_KEY_FILE"
  if [[ ! -r "$key" ]]; then
    log "[observer] Logs SSH key not readable: ${key}"
    exit 1
  fi
  chmod 600 "$key" 2>/dev/null || true

  log "[observer] Streaming remote bot logs (SSH) as ${OBSERVER_SSH_LOGS_USER}@${OBSERVER_SSH_LOGS_HOST}"
  ssh \
    -o BatchMode=yes \
    -o StrictHostKeyChecking="${OBSERVER_SSH_STRICT_HOST_KEY_CHECKING:-accept-new}" \
    -i "$key" \
    -p "${OBSERVER_SSH_LOGS_PORT:-22}" \
    "${OBSERVER_SSH_LOGS_USER}@${OBSERVER_SSH_LOGS_HOST}"
}

main() {
  if [[ "${OBSERVER_ENABLE_REMOTE_LOGS:-1}" != 1 ]] && [[ -z "${OBSERVER_DATABASE_URL:-}" ]]; then
    log "[observer] Set OBSERVER_DATABASE_URL and/or OBSERVER_ENABLE_REMOTE_LOGS=1 — nothing to run"
    exit 1
  fi

  if [[ "${OBSERVER_SSH_DB_TUNNEL:-0}" == 1 ]]; then
    start_db_tunnel
  fi

  if [[ -n "${OBSERVER_DATABASE_URL:-}" ]]; then
    poll_trades_loop &
    poll_positions_loop &
    poll_config_loop &
  else
    log "[observer] OBSERVER_DATABASE_URL unset — DB polling disabled"
  fi

  if [[ "${OBSERVER_ENABLE_REMOTE_LOGS:-1}" == 1 ]]; then
    stream_remote_logs
  fi

  log "[observer] Remote logs disabled; waiting on background polls"
  wait
}

main "$@"
