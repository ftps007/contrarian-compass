#!/bin/bash
# One command to audit the local stock_data database and bundle the results.
#
#   ./scripts/check_my_data.sh              # audit only, changes nothing
#   ./scripts/check_my_data.sh --with-index-plan   # + dry-run index coverage
#
# Everything here is READ-ONLY. No migration is applied, no row is written,
# no index is created. The index-coverage step runs in dry-run mode and rolls
# back. Applying anything is a separate, explicit decision.
#
# Output lands in ./db_health_report_<date>/ :
#
#   00_summary.txt        the one-page verdict — read this first
#   01_quick.txt          fast profile: freshness, schema, universe
#   02_full_audit.txt     every ticker, entire history
#   03_full_audit.json    the same, machine-readable
#   04_coverage.csv       one row per ticker, 29 columns
#   05_total_return.txt   what measuring returns on close is costing
#   06_index_coverage.txt current index assignment + orphan count
#   07_environment.txt    versions and table sizes, for context
#
# The full audit does several unbounded window scans over price_data; expect
# roughly ten minutes on a 36M-row table. Nothing else needs to be stopped
# while it runs — the session is read-only and holds no locks that block the
# updater.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${TANGENCY_PYTHON:-python3}"
DB="${STOCK_DB_NAME:-stock_data}"
DBUSER="${STOCK_DB_USER:-${USER:-postgres}}"
DBHOST="${STOCK_DB_HOST:-localhost}"
DBPORT="${STOCK_DB_PORT:-5432}"
UNIVERSE="${HEALTH_UNIVERSE:-all_us}"
OUT="$PWD/db_health_report_$(date +%Y-%m-%d)"

WITH_INDEX_PLAN=0
[ "${1:-}" = "--with-index-plan" ] && WITH_INDEX_PLAN=1

CONN=(--dbname "$DB" --user "$DBUSER" --host "$DBHOST" --port "$DBPORT")

echo "auditing $DB@$DBHOST:$DBPORT  ->  $OUT"
mkdir -p "$OUT" || exit 4

# ── preflight ─────────────────────────────────────────────────────────────
if ! command -v pg_isready >/dev/null 2>&1 || \
   ! pg_isready -h "$DBHOST" -p "$DBPORT" >/dev/null 2>&1; then
    echo "ERROR: Postgres is not accepting connections at $DBHOST:$DBPORT" >&2
    echo "       start it, or set STOCK_DB_HOST / STOCK_DB_PORT" >&2
    exit 3
fi
if ! "$PYTHON" -c "import psycopg2" 2>/dev/null; then
    echo "ERROR: psycopg2 missing — pip install psycopg2-binary" >&2
    exit 3
fi

cd "$HERE" || exit 4

{
    echo "database:    $DB@$DBHOST:$DBPORT"
    echo "user:        $DBUSER"
    echo "generated:   $(date)"
    echo "python:      $("$PYTHON" --version 2>&1)"
    echo
    psql -h "$DBHOST" -p "$DBPORT" -U "$DBUSER" -d "$DB" -c "SELECT version();" 2>&1
    psql -h "$DBHOST" -p "$DBPORT" -U "$DBUSER" -d "$DB" -c "
        SELECT c.relname AS table,
               to_char(c.reltuples, 'FM999,999,999') AS est_rows,
               pg_size_pretty(pg_total_relation_size(c.oid)) AS total
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname='public' AND c.relkind='r'
         ORDER BY pg_total_relation_size(c.oid) DESC;" 2>&1
} > "$OUT/07_environment.txt"

step() { printf '  %-28s' "$1"; }
done_() { echo "${1:-ok}"; }

step "quick profile"
"$PYTHON" db_health_check.py "${CONN[@]}" --profile quick --universe "$UNIVERSE" \
    --color never --no-progress > "$OUT/01_quick.txt" 2>&1
QUICK_RC=$?
done_ "rc=$QUICK_RC"

step "full audit (~10 min)"
"$PYTHON" db_health_check.py "${CONN[@]}" --full-history --profile deep \
    --universe "$UNIVERSE" --samples 15 --color never --no-progress \
    --coverage-report "$OUT/04_coverage.csv" \
    --output "$OUT/02_full_audit.txt" > /dev/null 2>&1
FULL_RC=$?
done_ "rc=$FULL_RC"

step "full audit (json)"
"$PYTHON" db_health_check.py "${CONN[@]}" --full-history --profile deep \
    --universe "$UNIVERSE" --format json --no-progress \
    --output "$OUT/03_full_audit.json" >/dev/null 2>&1
done_

step "total-return gap"
"$PYTHON" pipeline/total_return.py "${CONN[@]}" --compare \
    --universe SP500,SP400 --horizon 365 > "$OUT/05_total_return.txt" 2>&1
done_

step "index coverage"
{
    "$PYTHON" pipeline/index_coverage.py "${CONN[@]}" --report 2>&1
    if [ "$WITH_INDEX_PLAN" = "1" ]; then
        echo; echo "=== dry-run plan (nothing written) ==="
        "$PYTHON" pipeline/index_coverage.py "${CONN[@]}" 2>&1
    fi
} > "$OUT/06_index_coverage.txt"
done_

# ── summary ───────────────────────────────────────────────────────────────
{
    echo "=================================================================="
    echo " stock_data audit — $(date +%Y-%m-%d)"
    echo "=================================================================="
    echo
    echo "QUICK PROFILE (exit $QUICK_RC)   FULL AUDIT (exit $FULL_RC)"
    echo "  0 = clean   1 = warnings   2 = failures   3 = checker/db error"
    echo
    sed -n '/VERDICT/,/^$/p' "$OUT/02_full_audit.txt" 2>/dev/null | head -6
    echo "------------------------------------------------------------------"
    echo "NEEDS ATTENTION"
    echo "------------------------------------------------------------------"
    awk '/NEEDS ATTENTION/,/ALL CHECKS/' "$OUT/02_full_audit.txt" 2>/dev/null \
        | grep -E "^  (FAIL|WARN|ERR )" | head -40
    echo
    echo "------------------------------------------------------------------"
    echo "PER-TICKER COVERAGE"
    echo "------------------------------------------------------------------"
    if [ -s "$OUT/04_coverage.csv" ]; then
        "$PYTHON" - "$OUT/04_coverage.csv" <<'PY'
import csv, sys, collections
rows = list(csv.DictReader(open(sys.argv[1])))
g = collections.Counter(r["grade"] for r in rows)
print(f"  {len(rows):,} tickers graded")
for k, v in g.most_common():
    print(f"    {k:<9} {v:>7,}  ({v/len(rows):.1%})")
bad = [r for r in rows if r["grade"] not in ("OK", "APPROX")]
if bad:
    bad.sort(key=lambda r: float(r["completeness"] or 0))
    print(f"\n  worst 15 of {len(bad):,} non-clean tickers:")
    for r in bad[:15]:
        print(f"    {r['ticker']:<9} {r['grade']:<8} {r['reasons'][:64]}")
PY
    else
        echo "  (coverage export not produced — see 02_full_audit.txt)"
    fi
    echo
    echo "------------------------------------------------------------------"
    echo "TOTAL-RETURN GAP"
    echo "------------------------------------------------------------------"
    grep -E "mean price|mean total|understatement|churn|rank displacement" \
        "$OUT/05_total_return.txt" 2>/dev/null | head -8
    echo
    echo "------------------------------------------------------------------"
    echo "INDEX COVERAGE"
    echo "------------------------------------------------------------------"
    grep -E "orphans|active" "$OUT/06_index_coverage.txt" 2>/dev/null | head -20
    echo
    echo "=================================================================="
    echo " full detail in $OUT"
    echo "=================================================================="
} > "$OUT/00_summary.txt" 2>&1

echo
cat "$OUT/00_summary.txt"
echo
echo "bundle: $OUT"
[ "$FULL_RC" -gt "$QUICK_RC" ] && exit "$FULL_RC"
exit "$QUICK_RC"
