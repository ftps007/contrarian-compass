#!/bin/bash
# Scheduled health check for the local stock_data Postgres.
#
# Usage:  db_health_cron.sh [quick|standard|deep]
#
# Suggested cadence (crontab or LaunchAgent):
#   0 23 * * 1-5   .../db_health_cron.sh quick    # after the weekday price load
#   0  9 * * 6     .../db_health_cron.sh deep     # before the weekly pipeline
#
# Exit codes propagate from db_health_check.py, so a wrapper can branch on
# severity: 0 clean, 1 warn, 2 fail, 3 checker/connection error.

set -uo pipefail

PROFILE="${1:-quick}"
PROJECT="${TANGENCY_HOME:-/Users/ftps/tangency_portfolio}"
PYTHON="${TANGENCY_PYTHON:-$PROJECT/venv/bin/python}"
LOGDIR="$PROJECT/logs"
STAMP="$(date +%Y-%m-%d_%H%M)"
LOG="$LOGDIR/db_health_${PROFILE}_${STAMP}.log"

cd "$PROJECT" || exit 4
mkdir -p "$LOGDIR"

# Persist so the score can be trended; harmless if migration 006 is not applied
# (the checker prints a note and carries on).
"$PYTHON" db_health_check.py \
    --profile "$PROFILE" \
    --universe "${HEALTH_UNIVERSE:-all_us}" \
    --persist \
    --color never \
    >> "$LOG" 2>&1
rc=$?

# Keep a machine-readable copy of the latest run for dashboards.
"$PYTHON" db_health_check.py \
    --profile "$PROFILE" \
    --universe "${HEALTH_UNIVERSE:-all_us}" \
    --format json \
    --output "$LOGDIR/db_health_latest_${PROFILE}.json" \
    --no-progress \
    >/dev/null 2>&1

case "$rc" in
  0) echo "$(date) health OK ($PROFILE)" >> "$LOGDIR/db_health.log" ;;
  1) echo "$(date) health WARN ($PROFILE) — see $LOG" >> "$LOGDIR/db_health.log" ;;
  2) echo "$(date) health FAIL ($PROFILE) — see $LOG" >> "$LOGDIR/db_health.log"
     # A FAIL means at least one defect can distort a simulation. Surface it
     # rather than letting it sit in a log nobody opens.
     if command -v osascript >/dev/null 2>&1; then
        osascript -e "display notification \"stock_data health FAIL ($PROFILE)\" with title \"DB Health\"" || true
     fi
     ;;
  *) echo "$(date) health ERROR rc=$rc ($PROFILE) — see $LOG" >> "$LOGDIR/db_health.log" ;;
esac

# Trim old per-run logs, keep the last 60.
ls -1t "$LOGDIR"/db_health_"${PROFILE}"_*.log 2>/dev/null | tail -n +61 | xargs -r rm -f

exit $rc
