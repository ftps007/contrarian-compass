#!/bin/bash
# Find every Postgres installation on this Mac and locate the stock_data DB.
#
#   ./scripts/find_postgres.sh
#
# Read-only: it starts nothing, changes nothing, connects only to instances
# that are already running. Ends by printing the exact connection parameters
# to hand to db_health_check.py.
#
# macOS ships Postgres in at least five different places depending on how it
# was installed, and STOCK_DATA.md does not record which one this project
# uses -- so this checks all of them rather than guessing.

set -uo pipefail

FOUND_ANY=0
hdr() { printf '\n\033[1m%s\033[0m\n%s\n' "$1" "$(printf '%.0s-' {1..66})"; }

# ── 1. What is actually running right now ────────────────────────────────
hdr "1. Running Postgres processes"
if pgrep -fl "postgres" 2>/dev/null | grep -v "find_postgres" | head -10; then
    FOUND_ANY=1
else
    echo "  none running"
fi

hdr "2. Listening ports"
# lsof is the reliable one on macOS; ss/netstat differ from Linux.
if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null \
        | grep -iE "postgres|:5432|:5433" || echo "  nothing on 5432/5433"
else
    netstat -an 2>/dev/null | grep -E "\.543[23].*LISTEN" || echo "  nothing on 5432/5433"
fi

# ── 3. Where it might be installed ───────────────────────────────────────
hdr "3. Installations on disk"
check_path() {
    [ -e "$1" ] && { echo "  FOUND  $2"; echo "         $1"; FOUND_ANY=1; }
}
check_path "/opt/homebrew/var/postgresql@14"  "Homebrew (Apple Silicon), pg14"
check_path "/opt/homebrew/var/postgresql@15"  "Homebrew (Apple Silicon), pg15"
check_path "/opt/homebrew/var/postgresql@16"  "Homebrew (Apple Silicon), pg16"
check_path "/opt/homebrew/var/postgresql@17"  "Homebrew (Apple Silicon), pg17"
check_path "/opt/homebrew/var/postgres"       "Homebrew (Apple Silicon), default"
check_path "/usr/local/var/postgres"          "Homebrew (Intel), default"
check_path "/usr/local/var/postgresql@16"     "Homebrew (Intel), pg16"
check_path "${HOME:-}/Library/Application Support/Postgres" "Postgres.app"
check_path "/Library/PostgreSQL"              "EDB installer"
for d in /opt/homebrew/var/postgresql* /usr/local/var/postgresql*; do
    [ -e "$d" ] && check_path "$d" "Homebrew (other version)"
done
[ "$FOUND_ANY" = "0" ] && echo "  no data directory in the usual places"

hdr "4. Homebrew services"
command -v brew >/dev/null 2>&1 \
    && brew services list 2>/dev/null | grep -i postgres || echo "  (brew not installed or no postgres service)"

hdr "5. Docker containers"
command -v docker >/dev/null 2>&1 \
    && docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null \
       | grep -i postgres || echo "  (docker not running or no postgres container)"

hdr "6. Client tools"
for b in psql pg_ctl pg_isready postgres; do
    p=$(command -v "$b" 2>/dev/null) && echo "  $b -> $p"
done
command -v psql >/dev/null 2>&1 && psql --version

# ── 7. Which databases exist, and where is stock_data ────────────────────
hdr "7. Databases reachable right now"
if ! command -v psql >/dev/null 2>&1; then
    echo "  psql not on PATH — cannot enumerate."
    echo "  Homebrew: brew install libpq && brew link --force libpq"
    exit 0
fi

HIT_HOST=""; HIT_PORT=""; HIT_USER=""
for port in 5432 5433; do
    # $USER can be unset in a non-login shell; whoami is the fallback.
    for user in "${USER:-$(whoami 2>/dev/null)}" postgres ftps; do
        [ -z "$user" ] && continue
        out=$(psql -h localhost -p "$port" -U "$user" -d postgres -tAc \
              "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY 1;" \
              2>/dev/null)
        [ -z "$out" ] && continue
        echo
        echo "  localhost:$port as '$user':"
        echo "$out" | sed 's/^/    /'
        if echo "$out" | grep -qx "stock_data"; then
            echo "    ^^^ stock_data IS HERE"
            HIT_HOST=localhost; HIT_PORT=$port; HIT_USER=$user
        fi
    done
done

if [ -z "$HIT_HOST" ]; then
    hdr "Result"
    echo "  stock_data not found on a running instance."
    echo
    echo "  If a data directory was listed in section 3 but nothing is running,"
    echo "  start it and re-run this script:"
    echo "    brew services start postgresql@16       # Homebrew"
    echo "    # or open Postgres.app"
    exit 1
fi

# ── 8. What is in it ─────────────────────────────────────────────────────
hdr "8. stock_data contents"
psql -h "$HIT_HOST" -p "$HIT_PORT" -U "$HIT_USER" -d stock_data -c "
    SELECT c.relname AS table,
           to_char(c.reltuples, 'FM999,999,999') AS est_rows,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS size
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY pg_total_relation_size(c.oid) DESC;" 2>&1

psql -h "$HIT_HOST" -p "$HIT_PORT" -U "$HIT_USER" -d stock_data -tAc \
    "SELECT 'price_data spans ' || MIN(date) || ' to ' || MAX(date)
            || '  (' || to_char(COUNT(*), 'FM999,999,999') || ' rows)'
       FROM price_data;" 2>/dev/null

hdr "Result — run the audit with these settings"
cat <<EOF
  export STOCK_DB_NAME=stock_data
  export STOCK_DB_USER=$HIT_USER
  export STOCK_DB_HOST=$HIT_HOST
  export STOCK_DB_PORT=$HIT_PORT

  ./scripts/check_my_data.sh

  # or the 0.1s version first:
  python db_health_check.py --dbname stock_data --user $HIT_USER \\
      --host $HIT_HOST --port $HIT_PORT --profile quick
EOF
