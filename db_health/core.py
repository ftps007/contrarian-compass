"""Core plumbing for the stock_data health checker.

Defines the result model, the check registry, the shared execution context
(connection + derived trading calendar + thresholds), and the runner.

Checks are plain functions registered with @check(...). Each returns one
Finding, a list of Findings, or None (meaning "nothing to report, all good"
— the runner synthesises a PASS in that case).
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from enum import IntEnum
from typing import Any, Callable, Iterable, Sequence


# ──────────────────────────────────────────────────────────────────────────────
# Result model
# ──────────────────────────────────────────────────────────────────────────────

class Status(IntEnum):
    """Ordered worst-last so max() over a set of statuses gives the roll-up."""
    PASS = 0
    INFO = 1
    SKIP = 2
    WARN = 3
    FAIL = 4
    ERROR = 5

    @property
    def label(self) -> str:
        return self.name


# How each status affects the process exit code / alerting.
BLOCKING = (Status.FAIL, Status.ERROR)


@dataclass
class Finding:
    """One check result."""
    check_id: str
    category: str
    title: str
    status: Status
    summary: str
    # Machine-readable measurement (row counts, ratios, dates...).
    metrics: dict[str, Any] = field(default_factory=dict)
    # Up to `sample_limit` offending rows, for the human reading the report.
    samples: list[dict[str, Any]] = field(default_factory=list)
    # What to do about it. Shown only for non-PASS findings.
    remediation: str = ""
    # Populated by the runner.
    duration_ms: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        d = {
            "check_id": self.check_id,
            "category": self.category,
            "title": self.title,
            "status": self.status.label,
            "summary": self.summary,
            "metrics": _jsonable(self.metrics),
            "duration_ms": round(self.duration_ms, 1),
        }
        if self.samples:
            d["samples"] = [_jsonable(s) for s in self.samples]
        if self.remediation and self.status not in (Status.PASS, Status.INFO):
            d["remediation"] = self.remediation
        return d


def _jsonable(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, (date, datetime)):
        return obj.isoformat()
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    # Decimal, Decimal-like, memoryview, etc.
    try:
        return float(obj)
    except (TypeError, ValueError):
        return str(obj)


# ──────────────────────────────────────────────────────────────────────────────
# Registry
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class RegisteredCheck:
    check_id: str
    category: str
    title: str
    fn: Callable[["Context"], Any]
    profiles: frozenset[str]
    # Checks that scan price_data row-by-row are expensive on 36M rows; the
    # runner reports them separately in --timing.
    heavy: bool = False


REGISTRY: list[RegisteredCheck] = []

# quick   — cheap, safe to run every day before the screener (catalogue metadata
#           + bounded-window scans only)
# standard— the default; adds full-window row scans over the configured window
# deep    — adds whole-table scans and bloat estimation; weekly
PROFILES = ("quick", "standard", "deep")
_PROFILE_RANK = {p: i for i, p in enumerate(PROFILES)}


def check(check_id: str, category: str, title: str,
          min_profile: str = "standard", heavy: bool = False):
    """Register a check. `min_profile` is the lightest profile that runs it."""
    if min_profile not in _PROFILE_RANK:
        raise ValueError(f"bad profile {min_profile!r}")
    profiles = frozenset(
        p for p in PROFILES if _PROFILE_RANK[p] >= _PROFILE_RANK[min_profile]
    )

    def deco(fn: Callable[["Context"], Any]):
        REGISTRY.append(RegisteredCheck(
            check_id=check_id, category=category, title=title,
            fn=fn, profiles=profiles, heavy=heavy,
        ))
        return fn
    return deco


# ──────────────────────────────────────────────────────────────────────────────
# Thresholds
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class Thresholds:
    """Every number the checker judges against, in one place.

    Defaults are tuned for a daily-updated US equity DB (~11k tickers, history
    back to 1927) feeding weekly contrarian backtests. Override on the CLI or
    via a JSON file (--thresholds).
    """
    # Freshness — in *trading* days, not calendar days.
    price_max_age_trading_days: int = 1          # WARN beyond this
    price_max_age_trading_days_fail: int = 3     # FAIL beyond this
    benchmark_max_age_trading_days: int = 1
    fundamentals_max_age_days: int = 10          # weekly cadence + slack
    fundamentals_max_age_days_fail: int = 31
    financials_max_age_days: int = 45
    catalysts_max_age_days: int = 21
    memberships_max_age_days: int = 45

    # Coverage on the most recent trading day, as a fraction of the active
    # universe. A partial load is the classic silent failure.
    latest_day_coverage_warn: float = 0.95
    latest_day_coverage_fail: float = 0.80
    # Cross-sectional row count vs trailing median, for partial-load days.
    daily_rowcount_drop_warn: float = 0.85
    daily_rowcount_drop_fail: float = 0.60

    # Per-ticker staleness: how many tickers may lag the latest trading day.
    stale_ticker_pct_warn: float = 0.05
    stale_ticker_pct_fail: float = 0.15
    stale_ticker_lag_days: int = 5               # trading days behind = stale

    # Panel completeness for simulations.
    min_history_rows: int = 252                  # 1y — screener beta needs this
    # A run of missing sessions this long is a defect regardless of how good
    # the overall ratio looks: a contiguous hole distorts momentum and drawdown
    # factors far more than the same count scattered across the series.
    max_acceptable_gap_sessions: int = 5
    # The NYSE calendar rules encoded here (see nyse_calendar.py) describe the
    # modern schedule. Before 1952 the exchange also traded Saturdays, so
    # expected-session counts for older series are unreliable and completeness
    # is reported as approximate rather than as a defect.
    calendar_reliable_from: date = date(1970, 1, 1)
    # Database-wide grade mix tolerated before the census escalates.
    inventory_bad_pct_warn: float = 0.05
    inventory_bad_pct_fail: float = 0.15
    sim_lookback_days: int = 750                 # matches the screener's cutoff
    panel_completeness_warn: float = 0.98        # observed/expected trading days
    panel_completeness_fail: float = 0.90
    universe_ready_pct_warn: float = 0.95
    universe_ready_pct_fail: float = 0.85

    # OHLC validity — any violation is a hard defect, so these are counts of
    # rows tolerated before escalating from WARN to FAIL.
    ohlc_violation_warn: int = 0
    ohlc_violation_fail: int = 100

    # Corruption / split detection.
    split_return_threshold: float = 0.35         # |1-day return| to investigate
    split_ratio_tolerance: float = 0.02          # closeness to a clean N:M ratio
    bad_tick_return_threshold: float = 0.50      # spike-and-revert magnitude
    bad_tick_revert_tolerance: float = 0.20      # how fully it must snap back
    adj_factor_tolerance: float = 0.01           # adj_close/close at latest date
    adj_factor_monotone_tolerance: float = 0.005
    flatline_min_days: int = 10                  # identical closes in a row
    zero_volume_streak_days: int = 10
    price_floor: float = 0.0001
    price_ceiling: float = 1_000_000.0

    # Fundamentals plausibility.
    fundamentals_coverage_warn: float = 0.80
    fundamentals_coverage_fail: float = 0.50
    pe_ceiling: float = 10_000.0
    roe_abs_ceiling: float = 50.0                # |ROE| as a ratio, not %
    debt_to_equity_ceiling: float = 10_000.0
    margin_abs_ceiling: float = 50.0
    null_snapshot_pct_warn: float = 0.10         # rows where everything is NULL

    # Index membership sanity — (low, high) inclusive bounds on active members.
    index_member_bounds: dict[str, tuple[int, int]] = field(default_factory=lambda: {
        "SP500": (490, 515),
        "SP400": (385, 415),
        "SP600": (580, 620),
        "NDX":   (95, 105),
        "DJI":   (28, 32),
        "RUI":   (900, 1100),
        "RUT":   (1800, 2200),
        "RUA":   (2700, 3200),
    })

    # Operational hygiene.
    dead_tuple_ratio_warn: float = 0.10
    dead_tuple_ratio_fail: float = 0.25
    analyze_max_age_days: int = 7
    index_to_table_ratio_warn: float = 1.0       # indexes larger than the table
    sequence_usage_warn: float = 0.80
    min_table_bytes_for_bloat: int = 50 * 1024 * 1024

    def apply_overrides(self, overrides: dict[str, Any]) -> list[str]:
        """Apply a dict of overrides in place. Returns the keys it rejected."""
        unknown: list[str] = []
        for k, v in overrides.items():
            if not hasattr(self, k):
                unknown.append(k)
                continue
            current = getattr(self, k)
            if isinstance(current, bool):
                setattr(self, k, bool(v))
            elif isinstance(current, date):
                setattr(self, k, v if isinstance(v, date) else date.fromisoformat(str(v)))
            elif isinstance(current, int) and not isinstance(current, bool):
                setattr(self, k, int(v))
            elif isinstance(current, float):
                setattr(self, k, float(v))
            else:
                setattr(self, k, v)
        return unknown


# ──────────────────────────────────────────────────────────────────────────────
# Execution context
# ──────────────────────────────────────────────────────────────────────────────

# Benchmarks tried in order when deriving the trading calendar. The calendar
# comes from the DB itself rather than an exchange-holiday library, so the
# checker has no network dependency and no extra package to install.
BENCHMARK_TICKERS = ("SPY", "^GSPC", "QQQ", "IWM", "DIA")

_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")


def quote_ident(name: str) -> str:
    """Defensive identifier quoting for names interpolated into SQL."""
    if not _IDENT_RE.match(name):
        raise ValueError(f"unsafe SQL identifier: {name!r}")
    return '"' + name + '"'


class Context:
    """Shared state handed to every check.

    Owns the connection, caches the things many checks need (trading calendar,
    universe stock_ids, catalogue introspection) so we pay for them once.
    """

    def __init__(self, conn, thresholds: Thresholds, *,
                 window_days: int = 400,
                 universe: str = "all_us",
                 sample_limit: int = 10,
                 profile: str = "standard",
                 scope: str = "universe",
                 today: date | None = None):
        self.conn = conn
        self.t = thresholds
        # window_days <= 0 means "no lower bound" — scan every row ever loaded.
        self.window_days = window_days
        self.universe = universe
        self.sample_limit = sample_limit
        self.profile = profile
        # "universe" = active members of `universe`; "all" = every tradable
        # ticker in `stocks`, which is what a full-database audit needs.
        self.scope = scope
        self.today = today or date.today()
        self._cache: dict[str, Any] = {}

    @property
    def unbounded(self) -> bool:
        return self.window_days <= 0

    @property
    def scope_label(self) -> str:
        return "database-wide" if self.scope == "all" else f"{self.universe} universe"

    @property
    def member_label(self) -> str:
        """Noun for one element of the target set, for report prose."""
        return "ticker" if self.scope == "all" else f"{self.universe} member"

    # ---- query helpers -------------------------------------------------

    def query(self, sql: str, params: Sequence[Any] | None = None) -> list[tuple]:
        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            if cur.description is None:
                return []
            return cur.fetchall()

    def query_dicts(self, sql: str, params: Sequence[Any] | None = None) -> list[dict]:
        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            if cur.description is None:
                return []
            cols = [c.name for c in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]

    def scalar(self, sql: str, params: Sequence[Any] | None = None) -> Any:
        rows = self.query(sql, params)
        if not rows or not rows[0]:
            return None
        return rows[0][0]

    def cached(self, key: str, producer: Callable[[], Any]) -> Any:
        if key not in self._cache:
            self._cache[key] = producer()
        return self._cache[key]

    # ---- catalogue introspection ---------------------------------------

    @property
    def tables(self) -> set[str]:
        return self.cached("tables", lambda: {
            r[0] for r in self.query(
                "SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
        })

    @property
    def views(self) -> set[str]:
        return self.cached("views", lambda: {
            r[0] for r in self.query(
                "SELECT viewname FROM pg_views WHERE schemaname = 'public'")
        })

    def has_table(self, name: str) -> bool:
        return name in self.tables

    def columns(self, table: str) -> dict[str, dict[str, Any]]:
        """column name -> {data_type, is_nullable, ...} for one table."""
        def load():
            rows = self.query_dicts("""
                SELECT column_name, data_type, is_nullable, numeric_precision,
                       numeric_scale, character_maximum_length
                  FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = %s
            """, (table,))
            return {r["column_name"]: r for r in rows}
        return self.cached(f"cols:{table}", load)

    # ---- trading calendar ----------------------------------------------

    @property
    def benchmark(self) -> tuple[int, str] | None:
        """(stock_id, ticker) of the first benchmark that has price history."""
        def load():
            for t in BENCHMARK_TICKERS:
                row = self.query(
                    "SELECT s.id, s.ticker FROM stocks s "
                    " WHERE s.ticker = %s "
                    "   AND EXISTS (SELECT 1 FROM price_data p WHERE p.stock_id = s.id) "
                    " LIMIT 1", (t,))
                if row:
                    return (row[0][0], row[0][1])
            return None
        return self.cached("benchmark", load)

    @property
    def calendar(self) -> list[date]:
        """Trading days inside the window, ascending, derived from the benchmark.

        This is the DB's own notion of "a day the market traded". If the
        benchmark itself is stale the calendar is short — which the freshness
        checks surface directly, so a stale benchmark can't silently mask
        staleness elsewhere.
        """
        def load():
            b = self.benchmark
            if not b:
                return []
            since = self.today - timedelta(days=max(self.window_days, 30))
            return [r[0] for r in self.query(
                "SELECT date FROM price_data "
                " WHERE stock_id = %s AND date >= %s AND date <= %s "
                " ORDER BY date", (b[0], since, self.today))]
        return self.cached("calendar", load)

    @property
    def last_trading_day(self) -> date | None:
        cal = self.calendar
        return cal[-1] if cal else None

    def trading_days_between(self, start: date, end: date) -> int:
        """Trading days in (start, end], per the benchmark calendar."""
        return sum(1 for d in self.calendar if start < d <= end)

    @property
    def window_start(self) -> date:
        # A sentinel far below any real bar (the panel starts in 1927) rather
        # than date.min, so it still fits a DATE column comparison cleanly.
        if self.unbounded:
            return date(1900, 1, 1)
        return self.today - timedelta(days=self.window_days)

    @property
    def window_label(self) -> str:
        return "all history" if self.unbounded else f"the last {self.window_days}d"

    @property
    def sim_since(self) -> date:
        """Start of the panel the coverage checks judge completeness over.

        Normally the screener's own 750-day cutoff. Unbounded mode widens it to
        every bar ever loaded, so a ticker is graded on its whole series rather
        than only the stretch a current backtest would read.
        """
        if self.unbounded:
            return date(1900, 1, 1)
        return self.today - timedelta(days=self.t.sim_lookback_days)

    @property
    def sim_since_label(self) -> str:
        return ("each ticker's full history" if self.unbounded
                else f"the last {self.t.sim_lookback_days}d")

    # ---- universe ------------------------------------------------------

    # Mirrors contrarian_screener.DB_COMPOSITE_UNIVERSES / DB_INDEX_MAP so the
    # checker validates exactly the universe the screener will later load.
    COMPOSITE_UNIVERSES = {
        "sp900":    ["SP500", "SP400"],
        "large_us": ["SP500", "SP400", "NDX", "RUI"],
        "all_us":   ["RUA", "SP500", "SP400"],
    }
    INDEX_MAP = {
        "sp500": "SP500", "sp400": "SP400", "sp600": "SP600",
        "nasdaq100": "NDX", "ndx": "NDX", "dow": "DJI", "dji": "DJI",
        "russell1000": "RUI", "russell2000": "RUT", "russell3000": "RUA",
        "nyse": "NYSE", "nasdaq": "IXIC",
    }

    def universe_index_symbols(self, name: str | None = None) -> list[str]:
        name = (name or self.universe).lower()
        if name in self.COMPOSITE_UNIVERSES:
            return list(self.COMPOSITE_UNIVERSES[name])
        if name in self.INDEX_MAP:
            return [self.INDEX_MAP[name]]
        # Allow a raw index symbol too ("SP500").
        return [name.upper()]

    @property
    def universe_stocks(self) -> list[tuple[int, str]]:
        """[(stock_id, ticker)] for the active members of the target universe."""
        def load():
            syms = self.universe_index_symbols()
            return [(r[0], r[1]) for r in self.query("""
                SELECT DISTINCT s.id, s.ticker
                  FROM stocks s
                  JOIN stock_index_members m ON m.stock_id = s.id
                  JOIN stock_indices i       ON i.id = m.index_id
                 WHERE i.symbol = ANY(%s) AND m.is_active = true
                 ORDER BY s.ticker
            """, (syms,))]
        return self.cached("universe_stocks", load)

    @property
    def universe_ids(self) -> list[int]:
        return [sid for sid, _ in self.universe_stocks]

    @property
    def all_stocks(self) -> list[tuple[int, str]]:
        """Every tradable ticker in `stocks` — the same filter the updater uses
        to decide what to fetch, so coverage is judged against exactly the set
        the pipeline claims to maintain."""
        def load():
            cols = self.columns("stocks")
            where = "ticker IS NOT NULL AND ticker <> ''"
            if "test_issue" in cols:
                where += " AND test_issue IS DISTINCT FROM 'Y'"
            return [(r[0], r[1]) for r in self.query(
                f"SELECT id, ticker FROM stocks WHERE {where} ORDER BY ticker")]
        return self.cached("all_stocks", load)

    # ---- target set -----------------------------------------------------
    # Checks scan `target_*` rather than `universe_*` so a single --scope flag
    # switches the whole suite between "the universe I simulate" and "every
    # ticker in the database".

    @property
    def target_stocks(self) -> list[tuple[int, str]]:
        return self.all_stocks if self.scope == "all" else self.universe_stocks

    @property
    def target_ids(self) -> list[int]:
        return [sid for sid, _ in self.target_stocks]

    @property
    def tradable_stocks_count(self) -> int:
        """Non-test-issue tickers — the denominator the updater itself uses."""
        def load():
            cols = self.columns("stocks")
            where = "ticker IS NOT NULL AND ticker <> ''"
            if "test_issue" in cols:
                where += " AND test_issue IS DISTINCT FROM 'Y'"
            return int(self.scalar(f"SELECT COUNT(*) FROM stocks WHERE {where}") or 0)
        return self.cached("tradable_count", load)


# ──────────────────────────────────────────────────────────────────────────────
# Runner
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class RunResult:
    findings: list[Finding]
    started_at: datetime
    duration_ms: float
    profile: str
    universe: str
    window_days: int

    @property
    def worst(self) -> Status:
        return max((f.status for f in self.findings), default=Status.PASS)

    def counts(self) -> dict[str, int]:
        out = {s.label: 0 for s in Status}
        for f in self.findings:
            out[f.status.label] += 1
        return out

    def by_category(self) -> dict[str, list[Finding]]:
        out: dict[str, list[Finding]] = {}
        for f in self.findings:
            out.setdefault(f.category, []).append(f)
        return out

    def score(self) -> float:
        """0-100 health score. PASS/INFO are free; SKIP is neutral (excluded).

        Weighted so one FAIL hurts far more than one WARN — a single corrupted
        price series can invalidate a whole backtest, while a WARN is usually
        "look at this before the next rebalance".
        """
        weights = {Status.PASS: 0.0, Status.INFO: 0.0,
                   Status.WARN: 1.0, Status.FAIL: 4.0, Status.ERROR: 4.0}
        scored = [f for f in self.findings if f.status != Status.SKIP]
        if not scored:
            return 100.0
        penalty = sum(weights[f.status] for f in scored)
        # Normalise against the worst case where every scored check FAILs.
        return round(max(0.0, 100.0 * (1 - penalty / (4.0 * len(scored)))), 1)

    def to_dict(self) -> dict[str, Any]:
        return {
            "started_at": self.started_at.isoformat(),
            "duration_ms": round(self.duration_ms, 1),
            "profile": self.profile,
            "universe": self.universe,
            "window_days": self.window_days,
            "status": self.worst.label,
            "score": self.score(),
            "counts": self.counts(),
            "findings": [f.to_dict() for f in self.findings],
        }


def _normalise(rc: RegisteredCheck, result: Any) -> list[Finding]:
    if result is None:
        return [Finding(rc.check_id, rc.category, rc.title, Status.PASS, "OK")]
    if isinstance(result, Finding):
        return [result]
    if isinstance(result, Iterable):
        out = [r for r in result if isinstance(r, Finding)]
        if not out:
            return [Finding(rc.check_id, rc.category, rc.title, Status.PASS, "OK")]
        return out
    raise TypeError(f"check {rc.check_id} returned {type(result)!r}")


def run_checks(ctx: Context, *, only: Sequence[str] | None = None,
               skip: Sequence[str] | None = None,
               progress: Callable[[str], None] | None = None) -> RunResult:
    started = datetime.now()
    t0 = time.perf_counter()
    findings: list[Finding] = []

    for rc in REGISTRY:
        if ctx.profile not in rc.profiles:
            continue
        if only and not any(_matches(rc, pat) for pat in only):
            continue
        if skip and any(_matches(rc, pat) for pat in skip):
            continue

        if progress:
            progress(rc.check_id)
        c0 = time.perf_counter()
        try:
            produced = _normalise(rc, rc.fn(ctx))
        except Exception as exc:                       # noqa: BLE001
            # A check that blows up is itself a finding — never abort the run.
            # Roll back so one bad query can't poison the rest of the session.
            try:
                ctx.conn.rollback()
            except Exception:                          # noqa: BLE001
                pass
            produced = [Finding(
                rc.check_id, rc.category, rc.title, Status.ERROR,
                f"check raised {type(exc).__name__}: {exc}",
                remediation="This is a bug in the checker or an unexpected "
                            "schema shape. Run with --traceback for detail.",
            )]
        elapsed = (time.perf_counter() - c0) * 1000
        for f in produced:
            f.duration_ms = elapsed / len(produced)
        findings.extend(produced)

    return RunResult(
        findings=findings,
        started_at=started,
        duration_ms=(time.perf_counter() - t0) * 1000,
        profile=ctx.profile,
        universe=ctx.universe,
        window_days=ctx.window_days,
    )


def _matches(rc: RegisteredCheck, pattern: str) -> bool:
    """--only/--skip accept a check id, a category, or a glob-ish prefix."""
    p = pattern.strip().lower()
    if p.endswith("*"):
        return rc.check_id.lower().startswith(p[:-1]) or \
               rc.category.lower().startswith(p[:-1])
    return p in (rc.check_id.lower(), rc.category.lower())


# ──────────────────────────────────────────────────────────────────────────────
# Small shared helpers for check authors
# ──────────────────────────────────────────────────────────────────────────────

def escalate(count: int, warn_at: int, fail_at: int) -> Status:
    """Count-based escalation: PASS at/below warn_at, FAIL at/above fail_at."""
    if count <= warn_at:
        return Status.PASS
    if count >= fail_at:
        return Status.FAIL
    return Status.WARN


def escalate_ratio(value: float, warn_below: float, fail_below: float) -> Status:
    """For "higher is better" ratios like coverage."""
    if value < fail_below:
        return Status.FAIL
    if value < warn_below:
        return Status.WARN
    return Status.PASS


def escalate_age(value: float, warn_above: float, fail_above: float) -> Status:
    """For "lower is better" measures like age and error counts."""
    if value > fail_above:
        return Status.FAIL
    if value > warn_above:
        return Status.WARN
    return Status.PASS


def pct(x: float) -> str:
    return f"{100 * x:.1f}%"
