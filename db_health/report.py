"""Report renderers: terminal, JSON, Markdown.

The terminal renderer is the one that gets read every morning, so it leads
with the verdict and the things that need action, and pushes passing checks to
a one-line-each tail.
"""

from __future__ import annotations

import json
import os
import sys
from typing import TextIO

from .core import Finding, RunResult, Status

_COLORS = {
    Status.PASS:  "\033[32m",
    Status.INFO:  "\033[36m",
    Status.SKIP:  "\033[90m",
    Status.WARN:  "\033[33m",
    Status.FAIL:  "\033[31m",
    Status.ERROR: "\033[35m",
}
_BOLD = "\033[1m"
_DIM = "\033[2m"
_RESET = "\033[0m"

_GLYPH = {
    Status.PASS: "PASS", Status.INFO: "INFO", Status.SKIP: "SKIP",
    Status.WARN: "WARN", Status.FAIL: "FAIL", Status.ERROR: "ERR ",
}

CATEGORY_ORDER = ["freshness", "coverage", "inventory", "corruption",
                  "validity", "fundamentals", "indices", "schema", "operations"]

CATEGORY_BLURB = {
    "freshness":    "is the data as new as it should be",
    "coverage":     "is the panel complete enough to simulate on",
    "inventory":    "every ticker in the DB, over its entire history",
    "corruption":   "silent data defects that distort simulations",
    "validity":     "per-row invariants that must always hold",
    "fundamentals": "quality of the factor inputs",
    "indices":      "universe definition and membership",
    "schema":       "structure, keys and indexes",
    "operations":   "Postgres health under the daily load",
}


def _use_color(stream: TextIO, force: bool | None) -> bool:
    if force is not None:
        return force
    if os.environ.get("NO_COLOR"):
        return False
    return hasattr(stream, "isatty") and stream.isatty()


class TerminalReporter:
    def __init__(self, stream: TextIO = sys.stdout, *, color: bool | None = None,
                 verbose: bool = False, width: int = 78):
        self.out = stream
        self.color = _use_color(stream, color)
        self.verbose = verbose
        self.width = width

    def _c(self, text: str, code: str) -> str:
        return f"{code}{text}{_RESET}" if self.color else text

    def _status(self, s: Status) -> str:
        return self._c(_GLYPH[s], _COLORS[s])

    def _rule(self, char: str = "─") -> None:
        print(char * self.width, file=self.out)

    def render(self, result: RunResult, *, db_label: str = "") -> None:
        o = self.out
        counts = result.counts()

        self._rule("═")
        title = "stock_data — DATABASE HEALTH REPORT"
        print(self._c(title, _BOLD), file=o)
        meta = (f"{db_label}  profile={result.profile}  "
                f"universe={result.universe}  window={result.window_days}d")
        print(self._c(meta.strip(), _DIM), file=o)
        print(self._c(result.started_at.strftime('%Y-%m-%d %H:%M:%S') +
                      f"   ({result.duration_ms / 1000:.1f}s)", _DIM), file=o)
        self._rule("═")

        verdict_color = _COLORS[result.worst]
        print(f"\n  {self._c('VERDICT', _BOLD)}   "
              f"{self._c(result.worst.label, verdict_color + _BOLD)}"
              f"   health score {self._c(f'{result.score():.1f}/100', _BOLD)}",
              file=o)
        summary = "   ".join(
            f"{self._c(_GLYPH[s].strip(), _COLORS[s])} {counts[s.label]}"
            for s in (Status.PASS, Status.INFO, Status.WARN, Status.FAIL,
                      Status.ERROR, Status.SKIP)
            if counts[s.label]
        )
        print(f"            {summary}\n", file=o)

        # Action list first — what a human should actually do today.
        actionable = [f for f in result.findings
                      if f.status in (Status.FAIL, Status.ERROR, Status.WARN)]
        actionable.sort(key=lambda f: (-int(f.status), f.check_id))
        if actionable:
            self._rule()
            print(self._c(" NEEDS ATTENTION", _BOLD), file=o)
            self._rule()
            for f in actionable:
                self._render_finding(f, detailed=True)
        else:
            print(self._c("  No issues found — every check passed.\n", _COLORS[Status.PASS]),
                  file=o)

        # Then everything, grouped, one line each.
        by_cat = result.by_category()
        self._rule()
        print(self._c(" ALL CHECKS", _BOLD), file=o)
        self._rule()
        ordered = ([c for c in CATEGORY_ORDER if c in by_cat] +
                   [c for c in by_cat if c not in CATEGORY_ORDER])
        for cat in ordered:
            findings = sorted(by_cat[cat], key=lambda f: f.check_id)
            worst = max(f.status for f in findings)
            blurb = CATEGORY_BLURB.get(cat, "")
            print(f"\n  {self._c(cat.upper(), _BOLD)} "
                  f"{self._c('— ' + blurb, _DIM) if blurb else ''}", file=o)
            for f in findings:
                if not self.verbose and f.status in (Status.FAIL, Status.ERROR,
                                                     Status.WARN):
                    # Already shown in full above; keep the roll-up line short.
                    print(f"    {self._status(f.status)}  {f.check_id:<34} "
                          f"{self._c('(see above)', _DIM)}", file=o)
                else:
                    print(f"    {self._status(f.status)}  {f.check_id:<34} "
                          f"{f.summary}", file=o)
            del worst

        print(file=o)
        self._rule("═")
        print(f" {self._c(result.worst.label, _COLORS[result.worst] + _BOLD)}"
              f"   score {result.score():.1f}/100"
              f"   {len(result.findings)} checks in "
              f"{result.duration_ms / 1000:.1f}s", file=o)
        self._rule("═")

    def _render_finding(self, f: Finding, *, detailed: bool) -> None:
        o = self.out
        print(f"\n  {self._status(f.status)}  {self._c(f.check_id, _BOLD)}  "
              f"{self._c('· ' + f.title, _DIM)}", file=o)
        for line in _wrap(f.summary, self.width - 10):
            print(f"        {line}", file=o)
        if detailed and f.samples:
            print(self._c(f"        examples ({len(f.samples)} shown):", _DIM),
                  file=o)
            for s in f.samples:
                print(self._c(f"          · {_fmt_sample(s)}", _DIM), file=o)
        if detailed and f.remediation:
            print(self._c("        → fix:", _BOLD), file=o)
            for para in f.remediation.split("\n"):
                for line in _wrap(para, self.width - 12):
                    print(f"          {line}", file=o)


def _fmt_sample(s: dict) -> str:
    parts = []
    for k, v in s.items():
        if v is None:
            continue
        if isinstance(v, float):
            v = f"{v:,.4g}"
        parts.append(f"{k}={v}")
    return "  ".join(parts)


def _wrap(text: str, width: int) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        if cur and len(cur) + 1 + len(w) > width:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    return lines or [""]


def render_json(result: RunResult, stream: TextIO = sys.stdout) -> None:
    json.dump(result.to_dict(), stream, indent=2, default=str)
    stream.write("\n")


def render_markdown(result: RunResult, stream: TextIO = sys.stdout, *,
                    db_label: str = "") -> None:
    o = stream
    counts = result.counts()
    print(f"# stock_data health report — {result.worst.label} "
          f"({result.score():.1f}/100)", file=o)
    print(f"\n`{db_label}` · profile `{result.profile}` · universe "
          f"`{result.universe}` · window {result.window_days}d · "
          f"{result.started_at:%Y-%m-%d %H:%M:%S} · "
          f"{result.duration_ms / 1000:.1f}s\n", file=o)
    print("| " + " | ".join(s.label for s in Status) + " |", file=o)
    print("|" + "---|" * len(Status), file=o)
    print("| " + " | ".join(str(counts[s.label]) for s in Status) + " |\n", file=o)

    actionable = sorted(
        (f for f in result.findings
         if f.status in (Status.FAIL, Status.ERROR, Status.WARN)),
        key=lambda f: (-int(f.status), f.check_id))
    if actionable:
        print("## Needs attention\n", file=o)
        for f in actionable:
            print(f"### `{f.check_id}` — {f.status.label}\n", file=o)
            print(f"{f.summary}\n", file=o)
            if f.samples:
                print("<details><summary>examples</summary>\n", file=o)
                for s in f.samples:
                    print(f"- `{_fmt_sample(s)}`", file=o)
                print("\n</details>\n", file=o)
            if f.remediation:
                print(f"**Fix:** {f.remediation}\n", file=o)
    else:
        print("## Needs attention\n\nNothing — all checks passed.\n", file=o)

    print("## All checks\n", file=o)
    print("| check | status | summary |", file=o)
    print("|---|---|---|", file=o)
    for f in sorted(result.findings, key=lambda f: (f.category, f.check_id)):
        summary = f.summary.replace("|", "\\|")
        print(f"| `{f.check_id}` | {f.status.label} | {summary} |", file=o)
