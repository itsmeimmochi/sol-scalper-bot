# Remote observer (local Docker)

Runs on your Mac (or any Docker host): streams **remote bot logs** over SSH and **polls Postgres** with a read-only role for trades, open positions, and config.

## Quick start

1. On the Coolify server, create the restricted SSH user and wrapper (below), and apply [`scripts/grant-observer-role.sql`](../scripts/grant-observer-role.sql) against production Postgres (edit `CHANGE_ME` first).
2. Copy [`env.example`](env.example) to `observer/.env` and fill in host paths and URLs.
3. From this directory:

```bash
docker compose up --build
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OBSERVER_SSH_LOGS_KEY_HOST_PATH` | yes (compose) | Host path to **private** key for log streaming (mounted read-only). |
| `OBSERVER_SSH_LOGS_HOST` | yes | SSH hostname for logs. |
| `OBSERVER_SSH_LOGS_USER` | yes | Linux user whose `authorized_keys` uses `command=` (wrapper). |
| `OBSERVER_SSH_LOGS_KEY_FILE` | yes | In-container path to mounted key (default in example: `/run/observer/ssh_logs_key`). |
| `OBSERVER_DATABASE_URL` | recommended | Read-only role URL (`scalper_observer`). |
| `OBSERVER_ENABLE_REMOTE_LOGS` | no | Set to `0` to disable SSH log stream (DB polls only). |
| `OBSERVER_POLL_INTERVAL_SECONDS` | no | Trade poll interval (default `30`). |
| `OBSERVER_POSITION_POLL_INTERVAL_SECONDS` | no | Open positions snapshot (default `60`). |
| `OBSERVER_CONFIG_POLL_INTERVAL_SECONDS` | no | `bot_config` snapshot (default `60`). |
| `OBSERVER_SSH_STRICT_HOST_KEY_CHECKING` | no | Passed to `ssh` (default `accept-new`). |
| `OBSERVER_SSH_DB_TUNNEL` | no | Set to `1` to open an SSH `-L` tunnel from inside the container before polling. |
| `OBSERVER_SSH_TUNNEL_KEY_HOST_PATH` | no | Host path for tunnel key; defaults to same file as logs key in compose. |
| `OBSERVER_SSH_TUNNEL_HOST` | if tunnel | SSH host for tunnel (often same as logs). |
| `OBSERVER_SSH_TUNNEL_USER` | if tunnel | User allowed **port forwarding** (separate from logs user recommended). |
| `OBSERVER_SSH_TUNNEL_REMOTE_SPEC` | if tunnel | e.g. `127.0.0.1:5432` (Postgres on server loopback). |
| `OBSERVER_TUNNEL_LOCAL_PORT` | if tunnel | Local port inside container (e.g. `15432`). |
| `OBSERVER_SSH_TUNNEL_KEY_FILE` | no | In-container tunnel key path (default `/run/observer/ssh_tunnel_key`). |

When **not** using the in-container tunnel, forward Postgres on your Mac and point `OBSERVER_DATABASE_URL` at `host.docker.internal`:

```bash
ssh -N -L 5433:127.0.0.1:5432 you@coolify-host
# OBSERVER_DATABASE_URL=postgresql://scalper_observer:...@host.docker.internal:5433/scalper
```

## Server-side SSH wrapper (logs channel)

Goal: the logs key can only run `docker compose logs` for this stack—not an interactive shell.

1. Create a dedicated user (example `scalper-observer`) in the `docker` group (or otherwise allowed to run `docker compose` in your Coolify project path).

2. Install a wrapper script owned by root, mode `0755`, e.g. `/usr/local/sbin/scalper-observer-logs.sh` (see also [`server-ssh-wrapper.example.sh`](server-ssh-wrapper.example.sh)):

```sh
#!/bin/sh
set -eu
# Directory that contains this repo's docker-compose.yml on the server (Coolify clone).
COMPOSE_DIR="${SCALPER_OBSERVER_COMPOSE_DIR:?set in /etc/default/scalper-observer or export}"
cd "$COMPOSE_DIR" || exit 1
exec docker compose logs -f --tail=500 bot
```

3. Set the directory in an env file the wrapper can read, e.g. `/etc/default/scalper-observer`:

```sh
SCALPER_OBSERVER_COMPOSE_DIR=/data/coolify/services/REPLACE_WITH_YOUR_UUID/code
```

Ensure `scalper-observer` user can read that file if needed, or hardcode `COMPOSE_DIR` in the script for simplicity.

4. In `~scalper-observer/.ssh/authorized_keys`, add **one line per key** (use a dedicated ed25519 keypair for the observer):

```text
command="/usr/local/sbin/scalper-observer-logs.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA...observer-logs...
```

5. Verify from your Mac:

```bash
ssh -i /path/to/logs_key scalper-observer@your-host
# Should attach to docker compose logs; no shell.
```

### Optional second key (Postgres tunnel)

Use a **different** key and user (e.g. `scalper-tunnel`) with **no** `command=`, and restrict forwarding in `authorized_keys`:

```text
permitopen="127.0.0.1:5432",no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA...tunnel-only...
```

Then connect with `ssh -N -L 5433:127.0.0.1:5432 -i tunnel_key scalper-tunnel@host` from your Mac, or set `OBSERVER_SSH_DB_TUNNEL=1` in `.env` and use the in-container tunnel settings.

## Failure modes

- **`OBSERVER_SSH_LOGS_KEY_HOST_PATH` unset** — `docker compose` fails at parse time; set it in `observer/.env`.
- **Wrong `COMPOSE_DIR` on server** — wrapper exits; SSH shows nothing or error from `docker compose`.
- **`host.docker.internal` on Linux** — compose adds `extra_hosts`; on older Docker Desktop for Mac, update Docker.
- **Read-only SQL errors** — ensure `grant-observer-role.sql` ran and password in URL matches; tunnel must reach **server** `127.0.0.1:5432` only if Postgres publishes there.

## Security notes

- The logs SSH user still invokes Docker; on a **dedicated** VM this matches the plan, but it is not a hard multi-tenant sandbox.
- Never put `WALLET_SECRET_KEY` or the bot’s write `DATABASE_URL` in `observer/.env`.
