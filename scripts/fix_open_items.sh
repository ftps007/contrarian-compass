#!/bin/bash
# Work through the remaining findings from the health report, in order.
#
#   ./scripts/fix_open_items.sh              # dry run — shows every step, changes nothing
#   ./scripts/fix_open_items.sh --apply
#   ./scripts/fix_open_items.sh --apply --skip-network   # A, C, E only
#
# Run from the tangency_portfolio root.
#
#   A  planner stats, empty fundamentals rows, redundant indexes   seconds
#   B  catalysts + fundamentals refresh                            minutes, network
#   C  index coverage: migration 007 + assignment                  a minute
#   D  stale index members                                         REPORT ONLY
#   E  invalid OHLC bars (warrants, penny stocks)                  a minute
#
# D is deliberately not automated. Deciding whether a ticker was delisted or
# renamed changes what happens to it -- one gets marked inactive, the other
# gets its symbol corrected and refetched -- and getting that backwards
# removes a live holding from the universe. The script prints the list and
# stops there.

set -uo pipefail

DBCHECK="${DBCHECK:-/tmp/dbcheck}"
DB="${STOCK_DB_NAME:-stock_data}"
DBUSER="${STOCK_DB_USER:-${USER:-postgres}}"
PSQL=(psql -d "$DB" -U "$DBUSER" -v ON_ERROR_STOP=1)
PY="${TANGENCY_PYTHON:-python3}"

APPLY=0
SKIP_NET=0
for a in "$@"; do
    [ "$a" = "--apply" ] && APPLY=1
    [ "$a" = "--skip-network" ] && SKIP_NET=1
done

step() { printf '\n\033[1m%s\033[0m\n%s\n' "$1" "$(printf '%.0s─' {1..70})"; }
run_sql() {
    if [ "$APPLY" = "1" ]; then "${PSQL[@]}" -c "$1"
    else echo "  [dry-run] $(echo "$1" | tr '\n' ' ' | cut -c1-100)..."; fi
}

[ "$APPLY" = "0" ] && echo "DRY RUN — nothing will be changed. Add --apply to execute."

# ── A ─────────────────────────────────────────────────────────────────────
step "A1  Planner statistics"
run_sql "ANALYZE;"

step "A2  Empty fundamentals snapshots"
EMPTY_PRED="trailing_pe IS NULL AND forward_pe IS NULL AND price_to_book IS NULL
 AND operating_margin IS NULL AND fcf_ttm IS NULL AND debt_to_equity IS NULL
 AND roe IS NULL AND revenue_growth_yoy IS NULL AND short_pct_float IS NULL
 AND recommendation_mean IS NULL AND days_to_earnings IS NULL AND market_cap IS NULL"
"${PSQL[@]}" -tAc "SELECT COUNT(*) FROM stock_fundamentals WHERE $EMPTY_PRED;" \
    | xargs -I{} echo "  {} all-NULL snapshot(s) present"
run_sql "DELETE FROM stock_fundamentals WHERE $EMPTY_PRED;"

step "A3  Redundant indexes"
# The safety check that was a manual instruction before: only drop an index
# that is neither PRIMARY nor UNIQUE. A duplicate plain index is dead weight;
# a unique one carries a constraint, and dropping it silently removes a
# guarantee the schema depends on.
DROP_SQL=$(cat <<'SQL'
DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.relname IN ('idx_stocks_exchange','idx_stocks_sector','idx_ticker',
                         'idx_stock_index','idx_catalysts_stock_date')
       AND NOT i.indisunique AND NOT i.indisprimary
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', r.name);
    RAISE NOTICE 'dropped %', r.name;
    n := n + 1;
  END LOOP;
  RAISE NOTICE '% redundant index(es) dropped', n;
END $$;
SQL
)
if [ "$APPLY" = "1" ]; then "${PSQL[@]}" -c "$DROP_SQL"; else
    "${PSQL[@]}" -tAc "
      SELECT '  would drop: ' || c.relname
        FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
       WHERE c.relname IN ('idx_stocks_exchange','idx_stocks_sector','idx_ticker',
                           'idx_stock_index','idx_catalysts_stock_date')
         AND NOT i.indisunique AND NOT i.indisprimary;"
fi

# ── B ─────────────────────────────────────────────────────────────────────
if [ "$SKIP_NET" = "1" ]; then
    step "B  Data refresh — SKIPPED (--skip-network)"
else
    step "B1  Catalysts"
    if [ "$APPLY" = "1" ]; then "$PY" update_stock_catalysts.py || echo "  (failed — not fatal)"
    else echo "  [dry-run] python update_stock_catalysts.py"; fi

    step "B2  Fundamentals"
    if [ "$APPLY" = "1" ]; then "$PY" update_stock_data.py --fundamentals-only || echo "  (failed — not fatal)"
    else echo "  [dry-run] python update_stock_data.py --fundamentals-only"; fi
fi

# ── C ─────────────────────────────────────────────────────────────────────
step "C  Index coverage"
if [ ! -f pipeline/migrations/007_index_coverage.sql ]; then
    echo "  pipeline/ not found here — copy it first:  cp -r $DBCHECK/pipeline ."
else
    if [ "$APPLY" = "1" ]; then
        "${PSQL[@]}" -q -f pipeline/migrations/007_index_coverage.sql && echo "  migration 007 applied"
        "$PY" pipeline/index_coverage.py --apply
    else
        echo "  [dry-run] psql -f pipeline/migrations/007_index_coverage.sql"
        "$PY" pipeline/index_coverage.py 2>/dev/null || echo "  (apply migration 007 first)"
    fi
fi

# ── D ─────────────────────────────────────────────────────────────────────
step "D  Stale index members — REPORT ONLY, needs your judgement"
"${PSQL[@]}" -c "
SELECT s.ticker, left(coalesce(s.name,''), 34) AS name,
       MAX(p.date) AS last_price,
       CURRENT_DATE - MAX(p.date) AS days_old
  FROM stocks s
  JOIN price_data p ON p.stock_id = s.id
  JOIN stock_index_members m ON m.stock_id = s.id AND m.is_active
  JOIN stock_indices i ON i.id = m.index_id AND i.symbol IN ('RUA','SP500','SP400')
 GROUP BY s.ticker, s.name
HAVING MAX(p.date) < CURRENT_DATE - 30
 ORDER BY 3;"
cat <<'NOTE'
  Two kinds, needing opposite treatment:
    delisted / acquired -> UPDATE stock_index_members SET is_active = false ...
    renamed             -> fix stocks.ticker, then backfill_ticker.py --all
  Guessing wrong drops a live holding out of the universe, so this one is
  left to you.
NOTE

# ── E ─────────────────────────────────────────────────────────────────────
step "E  Invalid OHLC bars"
if [ "$APPLY" = "1" ]; then
    (cd "$DBCHECK" && "$PY" -m db_health.repair --dbname "$DB" --user "$DBUSER" \
        --scan-invalid-bars --apply)
else
    (cd "$DBCHECK" && "$PY" -m db_health.repair --dbname "$DB" --user "$DBUSER" \
        --scan-invalid-bars 2>/dev/null | tail -20)
fi

# ── done ──────────────────────────────────────────────────────────────────
step "Done"
if [ "$APPLY" = "1" ]; then
    echo "  Re-check:"
    echo "    cd $DBCHECK && $PY db_health_check.py --dbname $DB --user $DBUSER"
else
    echo "  Dry run only. Re-run with --apply."
fi
