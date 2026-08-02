#!/bin/bash
# Run the health check and push the results to git, so they can be read
# without copy-pasting a terminal window.
#
#   ./scripts/sync_report.sh                 # standard profile
#   ./scripts/sync_report.sh quick
#   ./scripts/sync_report.sh full            # every ticker + coverage CSV
#
# Why this exists
# ---------------
# The database is on this Mac. Claude runs in a cloud container that cannot
# reach it -- not the database, not Yahoo, not iShares, not even Wikipedia.
# The one path that works in both directions is git: this machine can push,
# and Claude can pull.
#
# So instead of pasting output into a chat window, the output goes into the
# repository. Claude reads it from there. Same information, no transcription.
#
# WHERE IT PUSHES
# ---------------
# Defaults to the tangency-portfolio repo because it is PRIVATE. The reports
# name every ticker in the universe and how much history each one has -- not
# credentials, but not something to publish either. Override with $REPORT_REPO
# if you want them somewhere else, and think about visibility before you do.
#
# Nothing about the database is changed. The health check opens a read-only
# session.

set -uo pipefail

MODE="${1:-standard}"
DBCHECK="${DBCHECK:-/tmp/dbcheck}"
REPORT_REPO="${REPORT_REPO:-$HOME/tangency_portfolio}"
BRANCH="${REPORT_BRANCH:-db-health-reports}"
DB="${STOCK_DB_NAME:-stock_data}"
DBUSER="${STOCK_DB_USER:-${USER:-postgres}}"
PY="${TANGENCY_PYTHON:-python3}"
STAMP="$(date +%Y-%m-%d_%H%M)"
OUTDIR="$REPORT_REPO/db_health_reports"

step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ── preflight ─────────────────────────────────────────────────────────────
[ -d "$DBCHECK/db_health" ] || { echo "no $DBCHECK/db_health — set DBCHECK"; exit 4; }
[ -d "$REPORT_REPO/.git" ]  || { echo "no git repo at $REPORT_REPO — set REPORT_REPO"; exit 4; }
pg_isready -h "${STOCK_DB_HOST:-localhost}" >/dev/null 2>&1 || { echo "postgres not up"; exit 4; }

mkdir -p "$OUTDIR"
ARGS=(--dbname "$DB" --user "$DBUSER" --no-progress --color never)
case "$MODE" in
    quick)    ARGS+=(--profile quick) ;;
    full)     ARGS+=(--full-history --profile deep
                     --coverage-report "$OUTDIR/coverage_$STAMP.csv") ;;
    standard) ;;
    *) echo "usage: $0 [quick|standard|full]"; exit 4 ;;
esac

step "Running health check ($MODE)"
( cd "$DBCHECK" && "$PY" db_health_check.py "${ARGS[@]}" \
    --format json --output "$OUTDIR/report_$STAMP.json" )
RC=$?
( cd "$DBCHECK" && "$PY" db_health_check.py "${ARGS[@]}" \
    --output "$OUTDIR/report_$STAMP.txt" ) >/dev/null 2>&1

# latest.* are stable filenames so a reader does not have to guess the newest.
cp "$OUTDIR/report_$STAMP.json" "$OUTDIR/latest.json" 2>/dev/null
cp "$OUTDIR/report_$STAMP.txt"  "$OUTDIR/latest.txt"  2>/dev/null
[ -f "$OUTDIR/coverage_$STAMP.csv" ] && cp "$OUTDIR/coverage_$STAMP.csv" "$OUTDIR/latest_coverage.csv"

step "Diff against the previous run"
( cd "$DBCHECK" && "$PY" -m db_health.compare "$OUTDIR/latest.json" ) \
    2>&1 | tee "$OUTDIR/latest_diff.txt"

# ── push ──────────────────────────────────────────────────────────────────
step "Pushing to $BRANCH"
cd "$REPORT_REPO" || exit 4
CURRENT="$(git rev-parse --abbrev-ref HEAD)"
git fetch -q origin "$BRANCH" 2>/dev/null
if git show-ref --verify -q "refs/heads/$BRANCH"; then git checkout -q "$BRANCH"
elif git ls-remote --exit-code -q origin "$BRANCH" >/dev/null 2>&1; then
    git checkout -q -b "$BRANCH" "origin/$BRANCH"
else
    # Orphan branch: reports have nothing to do with the code history and
    # should not drag it along or create merge noise against it.
    git checkout -q --orphan "$BRANCH" && git rm -rq --cached . 2>/dev/null
fi

git add db_health_reports
if git diff --cached --quiet; then
    echo "  nothing new to push"
else
    SCORE=$("$PY" -c "import json;print(json.load(open('$OUTDIR/latest.json'))['score'])" 2>/dev/null)
    STATUS=$("$PY" -c "import json;print(json.load(open('$OUTDIR/latest.json'))['status'])" 2>/dev/null)
    git commit -qm "health report $STAMP ($MODE): $STATUS $SCORE/100"
    for i in 1 2 3 4; do
        git push -q -u origin "$BRANCH" && { echo "  pushed"; break; }
        echo "  push failed, retry $i"; sleep $((2 ** i))
    done
fi
git checkout -q "$CURRENT" 2>/dev/null

step "Done"
echo "  $OUTDIR/latest.json"
REMOTE=$(git remote get-url origin 2>/dev/null | sed 's/\.git$//;s#git@github.com:#https://github.com/#')
echo "  $REMOTE/blob/$BRANCH/db_health_reports/latest.txt"
echo
echo "  Tell Claude: \"neuer Report ist auf $BRANCH\" — it reads it from there."
exit $RC
