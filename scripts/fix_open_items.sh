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
# Every step MEASURES what it changed and the run ends with a table of
# before/after counts. An earlier version printed "pipeline/ not found here"
# and carried on, so step C silently did nothing while the run still looked
# successful -- the health check three hours later was the first sign. A step
# that cannot run is now a hard failure, and a step that runs has to show a
# number.
#
# D stays report-only. Deciding whether a ticker was delisted or renamed
# changes what happens to it -- one gets retired, the other gets its symbol
# corrected and refetched -- and getting that backwards removes a live holding
# from the universe.

set -uo pipefail

DBCHECK="${DBCHECK:-/tmp/dbcheck}"
DB="${STOCK_DB_NAME:-stock_data}"
DBUSER="${STOCK_DB_USER:-${USER:-postgres}}"
PSQL=(psql -d "$DB" -U "$DBUSER" -v ON_ERROR_STOP=1)
PY="${TANGENCY_PYTHON:-python3}"

APPLY=0; SKIP_NET=0
for a in "$@"; do
    [ "$a" = "--apply" ] && APPLY=1
    [ "$a" = "--skip-network" ] && SKIP_NET=1
done

declare -a SUMMARY=()
note() { SUMMARY+=("$1"); }
step() { printf '\n\033[1m%s\033[0m\n%s\n' "$1" "$(printf '%.0s─' {1..70})"; }
q()    { "${PSQL[@]}" -tAc "$1" 2>/dev/null | tr -d ' '; }
run_sql() {
    if [ "$APPLY" = "1" ]; then "${PSQL[@]}" -c "$1" >/dev/null
    else echo "  [dry-run] $(echo "$1" | tr '\n' ' ' | cut -c1-90)..."; fi
}

# ── preflight — refuse to start half-equipped ─────────────────────────────
step "Preflight"
FATAL=0
if ! q "SELECT 1" >/dev/null 2>&1 || [ "$(q 'SELECT 1')" != "1" ]; then
    echo "  FAIL  cannot query $DB as $DBUSER"; FATAL=1
else
    echo "  ok    database $DB reachable as $DBUSER"
fi
if [ ! -f pipeline/migrations/007_index_coverage.sql ] || [ ! -f pipeline/index_coverage.py ]; then
    echo "  FAIL  pipeline/ is not here (looked for pipeline/index_coverage.py)"
    echo "        step C would be skipped, which is what happened last time."
    echo "        Fix:  cp -r $DBCHECK/pipeline ."
    FATAL=1
else
    echo "  ok    pipeline/ present"
fi
if [ ! -d "$DBCHECK/db_health" ]; then
    echo "  FAIL  $DBCHECK/db_health missing — step E needs it."
    echo "        Set DBCHECK=/path/to/checkout, or clone it there."
    FATAL=1
else
    echo "  ok    $DBCHECK/db_health present"
fi
if [ "$FATAL" = "1" ]; then
    echo -e "\n  Refusing to run a partial pass. Fix the above and re-run."
    exit 4
fi
[ "$APPLY" = "0" ] && echo -e "\n  DRY RUN — nothing will be changed. Add --apply."

# ── A ─────────────────────────────────────────────────────────────────────
step "A1  Planner statistics"
run_sql "ANALYZE;"
note "A1  ANALYZE                     $([ "$APPLY" = 1 ] && echo done || echo 'dry-run')"

step "A2  Empty fundamentals snapshots"
EMPTY_PRED="trailing_pe IS NULL AND forward_pe IS NULL AND price_to_book IS NULL
 AND operating_margin IS NULL AND fcf_ttm IS NULL AND debt_to_equity IS NULL
 AND roe IS NULL AND revenue_growth_yoy IS NULL AND short_pct_float IS NULL
 AND recommendation_mean IS NULL AND days_to_earnings IS NULL AND market_cap IS NULL"
A2_BEFORE=$(q "SELECT COUNT(*) FROM stock_fundamentals WHERE $EMPTY_PRED")
echo "  before: $A2_BEFORE all-NULL snapshot(s)"
run_sql "DELETE FROM stock_fundamentals WHERE $EMPTY_PRED;"
A2_AFTER=$(q "SELECT COUNT(*) FROM stock_fundamentals WHERE $EMPTY_PRED")
echo "  after:  $A2_AFTER"
note "A2  empty snapshots             $A2_BEFORE → $A2_AFTER"

step "A3  Redundant indexes"
# Only ever drop an index that is neither PRIMARY nor UNIQUE: a duplicate
# plain index is dead weight, a unique one carries a constraint.
A3_LIST="SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid
 WHERE c.relname IN ('idx_stocks_exchange','idx_stocks_sector','idx_ticker',
                     'idx_stock_index','idx_catalysts_stock_date')
   AND NOT i.indisunique AND NOT i.indisprimary"
A3_BEFORE=$(q "SELECT COUNT(*) FROM ($A3_LIST) t")
echo "  droppable: $A3_BEFORE"
"${PSQL[@]}" -tAc "$A3_LIST" 2>/dev/null | sed 's/^/    /'
if [ "$APPLY" = "1" ]; then
    "${PSQL[@]}" -tAc "$A3_LIST" 2>/dev/null | while read -r ix; do
        [ -n "$ix" ] && "${PSQL[@]}" -c "DROP INDEX IF EXISTS $ix;" >/dev/null && echo "    dropped $ix"
    done
fi
A3_AFTER=$(q "SELECT COUNT(*) FROM ($A3_LIST) t")
note "A3  redundant indexes           $A3_BEFORE → $A3_AFTER"

# ── B ─────────────────────────────────────────────────────────────────────
if [ "$SKIP_NET" = "1" ]; then
    step "B  Data refresh — SKIPPED (--skip-network)"
    note "B   data refresh               skipped"
else
    step "B1  Catalysts"
    B1_BEFORE=$(q "SELECT COALESCE(MAX(catalyst_date)::text,'none') FROM stock_catalysts")
    echo "  newest before: $B1_BEFORE"
    if [ "$APPLY" = "1" ]; then "$PY" update_stock_catalysts.py; echo "  exit=$?"; fi
    B1_AFTER=$(q "SELECT COALESCE(MAX(catalyst_date)::text,'none') FROM stock_catalysts")
    echo "  newest after:  $B1_AFTER"
    note "B1  newest catalyst            $B1_BEFORE → $B1_AFTER"

    step "B2  Fundamentals"
    B2_BEFORE=$(q "SELECT COUNT(*) FROM (SELECT stock_id FROM stock_fundamentals
                    WHERE snapshot_date >= CURRENT_DATE - 10 GROUP BY stock_id) t")
    echo "  stocks snapshotted in the last 10d, before: $B2_BEFORE"
    if [ "$APPLY" = "1" ]; then "$PY" update_stock_data.py --fundamentals-only; echo "  exit=$?"; fi
    B2_AFTER=$(q "SELECT COUNT(*) FROM (SELECT stock_id FROM stock_fundamentals
                   WHERE snapshot_date >= CURRENT_DATE - 10 GROUP BY stock_id) t")
    echo "  after: $B2_AFTER"
    note "B2  stocks with fresh funds    $B2_BEFORE → $B2_AFTER"
fi

# ── C ─────────────────────────────────────────────────────────────────────
step "C  Index coverage"
ORPH="SELECT COUNT(*) FROM stocks s WHERE s.ticker IS NOT NULL AND s.ticker <> ''
        AND s.test_issue IS DISTINCT FROM 'Y'
        AND NOT EXISTS (SELECT 1 FROM stock_index_members m
                         WHERE m.stock_id = s.id AND m.is_active)"
C_BEFORE=$(q "$ORPH")
echo "  orphans before: $C_BEFORE"
if [ "$APPLY" = "1" ]; then
    "${PSQL[@]}" -q -f pipeline/migrations/007_index_coverage.sql || {
        echo "  MIGRATION FAILED — stopping, step C is the biggest change here"; exit 2; }
    echo "  migration 007 applied"
    "$PY" pipeline/index_coverage.py --apply || {
        echo "  index_coverage FAILED"; exit 2; }
else
    echo "  [dry-run] psql -f pipeline/migrations/007_index_coverage.sql"
    "$PY" pipeline/index_coverage.py 2>&1 | tail -14
fi
C_AFTER=$(q "$ORPH")
echo "  orphans after:  $C_AFTER"
note "C   orphan tickers              $C_BEFORE → $C_AFTER"

# ── D ─────────────────────────────────────────────────────────────────────
step "D  Stale index members — REPORT ONLY"
"${PSQL[@]}" -c "
SELECT s.ticker, left(coalesce(s.name,''), 32) AS name,
       MAX(p.date) AS last_price, CURRENT_DATE - MAX(p.date) AS days_old
  FROM stocks s
  JOIN price_data p ON p.stock_id = s.id
  JOIN stock_index_members m ON m.stock_id = s.id AND m.is_active
  JOIN stock_indices i ON i.id = m.index_id AND i.symbol IN ('RUA','SP500','SP400')
 GROUP BY s.ticker, s.name HAVING MAX(p.date) < CURRENT_DATE - 30
 ORDER BY 3 LIMIT 25;"
echo "  Classify these with:  $PY pipeline/triage_stale.py"
note "D   stale members               reported only"

# ── E ─────────────────────────────────────────────────────────────────────
step "E  Invalid OHLC bars"
BAD="SELECT COUNT(*) FROM price_data p WHERE p.date >= CURRENT_DATE - 400
      AND (p.high < p.low OR p.close <= 0 OR p.close IS NULL OR p.volume < 0
           OR (p.open IS NOT NULL AND p.close IS NOT NULL
               AND (p.high < GREATEST(p.open,p.close)
                 OR p.low  > LEAST(p.open,p.close))))"
E_BEFORE=$(q "$BAD")
echo "  invalid bars before: $E_BEFORE"
if [ "$APPLY" = "1" ]; then
    (cd "$DBCHECK" && "$PY" -m db_health.repair --dbname "$DB" --user "$DBUSER" \
        --scan-invalid-bars --apply | tail -4)
else
    (cd "$DBCHECK" && "$PY" -m db_health.repair --dbname "$DB" --user "$DBUSER" \
        --scan-invalid-bars 2>/dev/null | tail -6)
fi
E_AFTER=$(q "$BAD")
echo "  invalid bars after:  $E_AFTER"
note "E   invalid bars                $E_BEFORE → $E_AFTER"

# ── summary ───────────────────────────────────────────────────────────────
step "Summary"
printf '  %s\n' "${SUMMARY[@]}"
if [ "$APPLY" = "1" ]; then
    echo -e "\n  Any line still showing an unchanged number did NOT take effect."
    echo "  Re-check:  cd $DBCHECK && $PY db_health_check.py \\"
    echo "               --dbname $DB --user $DBUSER --format json --output /tmp/after.json"
else
    echo -e "\n  Dry run. Re-run with --apply."
fi
