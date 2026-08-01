"""Command-line entry point for the stock_data health checker."""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from datetime import date

try:
    import psycopg2
    from psycopg2.extras import Json
except ImportError:                                    # pragma: no cover
    psycopg2 = None
    Json = None

from . import __version__
from .core import (PROFILES, Context, RunResult, Status, Thresholds, REGISTRY,
                   run_checks)
from .report import TerminalReporter, render_markdown

# Importing the check modules is what populates REGISTRY.
from . import checks_schema      # noqa: F401
from . import checks_freshness   # noqa: F401
from . import checks_integrity   # noqa: F401
from . import checks_coverage    # noqa: F401
from . import checks_fundamentals  # noqa: F401
from . import checks_ops         # noqa: F401


DEFAULT_DSN_PARTS = {
    "dbname": os.environ.get("STOCK_DB_NAME", "stock_data"),
    "user": os.environ.get("STOCK_DB_USER", os.environ.get("USER", "postgres")),
    "host": os.environ.get("STOCK_DB_HOST", "localhost"),
    "port": int(os.environ.get("STOCK_DB_PORT", "5432")),
}

# Exit codes — chosen so cron/LaunchAgent can branch on severity.
EXIT_OK = 0
EXIT_WARN = 1
EXIT_FAIL = 2
EXIT_ERROR = 3
EXIT_USAGE = 4


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="db_health_check",
        description="Detailed health check for the local stock_data Postgres "
                    "database that backs the contrarian screener and backtests.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
examples:
  # daily, before the screener run — cheap, catalogue + bounded scans
  python db_health_check.py --profile quick

  # standard pass against the universe you actually simulate
  python db_health_check.py --universe all_us

  # weekly deep pass, machine-readable, recorded for trending
  python db_health_check.py --profile deep --persist --json > health.json

  # just the checks that protect simulations from silent corruption
  python db_health_check.py --only corruption --only coverage

  # gate a pipeline: non-zero exit on anything worse than a warning
  python db_health_check.py --quiet --fail-on fail || echo "do not rebalance"
""")

    g = p.add_argument_group("connection")
    g.add_argument("--dsn", help="libpq connection string; overrides the parts "
                                 "below and $STOCK_DB_* / $DATABASE_URL")
    g.add_argument("--dbname", default=DEFAULT_DSN_PARTS["dbname"])
    g.add_argument("--user", default=DEFAULT_DSN_PARTS["user"])
    g.add_argument("--host", default=DEFAULT_DSN_PARTS["host"])
    g.add_argument("--port", type=int, default=DEFAULT_DSN_PARTS["port"])
    g.add_argument("--statement-timeout", type=int, default=600,
                   help="per-query timeout in seconds (default 600; 0 disables)")

    g = p.add_argument_group("scope")
    g.add_argument("--profile", choices=PROFILES, default="standard",
                   help="quick = catalogue + bounded scans; standard = default; "
                        "deep = adds whole-table scans and bloat measurement")
    g.add_argument("--universe", default="all_us",
                   help="universe to validate against, as the screener names "
                        "them (all_us, sp900, large_us, sp500, ndx, ...)")
    g.add_argument("--window-days", type=int, default=400,
                   help="lookback for row-level scans (default 400)")
    g.add_argument("--only", action="append", default=[], metavar="ID|CATEGORY",
                   help="run only these checks/categories (repeatable, "
                        "trailing * allowed)")
    g.add_argument("--skip", action="append", default=[], metavar="ID|CATEGORY",
                   help="skip these checks/categories (repeatable)")
    g.add_argument("--list-checks", action="store_true",
                   help="print the check catalogue and exit")

    g = p.add_argument_group("thresholds")
    g.add_argument("--thresholds", metavar="FILE",
                   help="JSON file of threshold overrides")
    g.add_argument("--set", action="append", default=[], metavar="KEY=VALUE",
                   help="override a single threshold (repeatable)")

    g = p.add_argument_group("output")
    g.add_argument("--format", choices=("text", "json", "markdown"),
                   default="text")
    g.add_argument("--json", action="store_const", const="json", dest="format",
                   help="shorthand for --format json")
    g.add_argument("--output", "-o", metavar="FILE", help="write report to FILE")
    g.add_argument("--samples", type=int, default=10,
                   help="offending rows to show per check (default 10)")
    g.add_argument("--verbose", "-v", action="store_true",
                   help="show full detail for every check, not just problems")
    g.add_argument("--quiet", "-q", action="store_true",
                   help="suppress the report; exit code only")
    g.add_argument("--color", choices=("auto", "always", "never"), default="auto")
    g.add_argument("--no-progress", action="store_true",
                   help="do not print check-in-progress lines to stderr")
    g.add_argument("--traceback", action="store_true",
                   help="show tracebacks for checks that raise")

    g = p.add_argument_group("behaviour")
    g.add_argument("--fail-on", choices=("never", "warn", "fail"), default="fail",
                   help="lowest severity that produces a non-zero exit "
                        "(default: fail)")
    g.add_argument("--persist", action="store_true",
                   help="record this run in data_quality_runs / "
                        "data_quality_findings (requires migration 006)")
    g.add_argument("--asof", metavar="YYYY-MM-DD",
                   help="treat this date as today (for testing)")
    g.add_argument("--version", action="version",
                   version=f"%(prog)s {__version__}")
    return p


def connect(args):
    if psycopg2 is None:
        sys.exit("psycopg2 is required: pip install psycopg2-binary")
    dsn = args.dsn or os.environ.get("STOCK_DB_DSN")
    if dsn:
        return psycopg2.connect(dsn)
    return psycopg2.connect(dbname=args.dbname, user=args.user,
                            host=args.host, port=args.port)


def load_thresholds(args) -> Thresholds:
    t = Thresholds()
    unknown: list[str] = []
    if args.thresholds:
        with open(args.thresholds) as fh:
            unknown += t.apply_overrides(json.load(fh))
    kv = {}
    for item in args.set:
        if "=" not in item:
            sys.exit(f"--set expects KEY=VALUE, got {item!r}")
        k, v = item.split("=", 1)
        try:
            kv[k.strip()] = json.loads(v)
        except json.JSONDecodeError:
            kv[k.strip()] = v
    unknown += t.apply_overrides(kv)
    if unknown:
        sys.exit(f"unknown threshold(s): {', '.join(sorted(set(unknown)))}")
    return t


def list_checks(stream=sys.stdout) -> None:
    by_cat: dict[str, list] = {}
    for rc in REGISTRY:
        by_cat.setdefault(rc.category, []).append(rc)
    for cat in sorted(by_cat):
        print(f"\n{cat.upper()}", file=stream)
        for rc in sorted(by_cat[cat], key=lambda r: r.check_id):
            lightest = next(p for p in PROFILES if p in rc.profiles)
            heavy = " [heavy]" if rc.heavy else ""
            print(f"  {rc.check_id:<34} {lightest:<8} {rc.title}{heavy}",
                  file=stream)
    print(f"\n{len(REGISTRY)} checks total.", file=stream)


def persist(conn, result: RunResult, *, db_label: str) -> int | None:
    """Record the run so the score can be trended. Best-effort."""
    if Json is None:
        return None
    with conn.cursor() as cur:
        cur.execute("""
            SELECT to_regclass('public.data_quality_runs') IS NOT NULL,
                   to_regclass('public.data_quality_findings') IS NOT NULL
        """)
        have_runs, have_findings = cur.fetchone()
        if not have_runs:
            print("--persist: data_quality_runs missing; apply "
                  "db_health/migrations/006_data_quality.sql", file=sys.stderr)
            return None
        cur.execute("""
            INSERT INTO data_quality_runs
                (started_at, duration_ms, profile, universe, window_days,
                 status, score, n_pass, n_info, n_warn, n_fail, n_error, n_skip,
                 target)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (result.started_at, result.duration_ms, result.profile,
              result.universe, result.window_days, result.worst.label,
              result.score(), *[result.counts()[s.label] for s in
                                (Status.PASS, Status.INFO, Status.WARN,
                                 Status.FAIL, Status.ERROR, Status.SKIP)],
              db_label))
        run_id = cur.fetchone()[0]
        if have_findings:
            for f in result.findings:
                cur.execute("""
                    INSERT INTO data_quality_findings
                        (run_id, check_id, category, status, summary,
                         metrics, samples, duration_ms)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """, (run_id, f.check_id, f.category, f.status.label,
                      f.summary, Json(f.to_dict().get("metrics", {})),
                      Json(f.to_dict().get("samples", [])), f.duration_ms))
        conn.commit()
        return run_id


def exit_code_for(result: RunResult, fail_on: str) -> int:
    worst = result.worst
    if fail_on == "never":
        return EXIT_OK
    if worst == Status.ERROR:
        return EXIT_ERROR
    if worst == Status.FAIL:
        return EXIT_FAIL
    if worst == Status.WARN and fail_on == "warn":
        return EXIT_WARN
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.list_checks:
        list_checks()
        return EXIT_OK

    thresholds = load_thresholds(args)

    asof = None
    if args.asof:
        try:
            asof = date.fromisoformat(args.asof)
        except ValueError:
            sys.exit(f"--asof expects YYYY-MM-DD, got {args.asof!r}")

    try:
        conn = connect(args)
    except Exception as exc:                           # noqa: BLE001
        if args.traceback:
            traceback.print_exc()
        print(f"FAIL  cannot connect to the database: {exc}", file=sys.stderr)
        print("      Check that Postgres is running (pg_isready) and that "
              "--dbname/--host/--user are right.", file=sys.stderr)
        return EXIT_ERROR

    conn.set_session(readonly=True, autocommit=False)
    db_label = f"{args.dbname}@{args.host}:{args.port}" if not args.dsn else "dsn"
    try:
        if args.statement_timeout:
            with conn.cursor() as cur:
                cur.execute("SET statement_timeout = %s",
                            (args.statement_timeout * 1000,))

        ctx = Context(conn, thresholds, window_days=args.window_days,
                      universe=args.universe, sample_limit=args.samples,
                      profile=args.profile, today=asof)

        def _progress(cid: str) -> None:
            print(f"\r  running {cid:<40}", end="", file=sys.stderr, flush=True)

        show_progress = (not args.no_progress and not args.quiet
                         and sys.stderr.isatty())
        progress = _progress if show_progress else None

        result = run_checks(ctx, only=args.only or None,
                            skip=args.skip or None, progress=progress)
        if progress:
            print("\r" + " " * 52 + "\r", end="", file=sys.stderr, flush=True)
    finally:
        pass

    # --persist needs a writable session; reconnect rather than widening the
    # read-only guard that protects the main run.
    run_id = None
    if args.persist:
        try:
            conn.close()
            wconn = connect(args)
            run_id = persist(wconn, result, db_label=db_label)
            wconn.close()
        except Exception as exc:                       # noqa: BLE001
            if args.traceback:
                traceback.print_exc()
            print(f"--persist failed: {exc}", file=sys.stderr)
    else:
        conn.close()

    if not args.quiet:
        stream = open(args.output, "w") if args.output else sys.stdout
        try:
            if args.format == "json":
                payload = result.to_dict()
                payload["target"] = db_label
                if run_id:
                    payload["run_id"] = run_id
                json.dump(payload, stream, indent=2, default=str)
                stream.write("\n")
            elif args.format == "markdown":
                render_markdown(result, stream, db_label=db_label)
            else:
                color = {"auto": None, "always": True,
                         "never": False}[args.color]
                TerminalReporter(stream, color=color,
                                 verbose=args.verbose).render(
                    result, db_label=db_label)
        finally:
            if args.output:
                stream.close()

    return exit_code_for(result, args.fail_on)


if __name__ == "__main__":
    sys.exit(main())
