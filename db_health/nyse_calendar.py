"""A self-contained NYSE trading calendar.

The checker needs to answer "should the market have traded on this date?"
without a network call and without adding pandas_market_calendars as a
dependency. Deriving the calendar purely from the benchmark ticker's own rows
cannot answer it: if a load is skipped for a whole day, the benchmark is
missing that day too, so the gap becomes invisible to itself.

This module computes the NYSE holiday schedule from the published rules, which
have been stable since 2022 (Juneteenth was the last addition). It covers
regular holidays and their weekend observance; it does not model one-off
closures (hurricanes, national days of mourning), so a genuinely closed day
that is not on this list shows up as a false "missing day" — the checks that
use it say so, and such closures are rare enough to be worth an occasional
manual dismissal.
"""

from __future__ import annotations

from datetime import date, timedelta
from functools import lru_cache


def easter(year: int) -> date:
    """Anonymous Gregorian algorithm. Good Friday is Easter minus two days."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    L = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * L) // 451
    month, day = divmod(h + L - 7 * m + 114, 31)
    return date(year, month, day + 1)


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """n-th `weekday` (Mon=0) of a month; n = -1 means the last one."""
    if n > 0:
        d = date(year, month, 1)
        offset = (weekday - d.weekday()) % 7
        return d + timedelta(days=offset + 7 * (n - 1))
    nxt = date(year + (month == 12), month % 12 + 1, 1)
    d = nxt - timedelta(days=1)
    return d - timedelta(days=(d.weekday() - weekday) % 7)


def _observed(d: date) -> date:
    """Weekend holidays shift: Saturday -> Friday, Sunday -> Monday."""
    if d.weekday() == 5:
        return d - timedelta(days=1)
    if d.weekday() == 6:
        return d + timedelta(days=1)
    return d


@lru_cache(maxsize=256)
def nyse_holidays(year: int) -> frozenset[date]:
    """Full-day NYSE closures for a calendar year."""
    days = {
        _observed(date(year, 1, 1)),                    # New Year's Day
        _nth_weekday(year, 1, 0, 3),                    # MLK Jr Day
        _nth_weekday(year, 2, 0, 3),                    # Washington's Birthday
        easter(year) - timedelta(days=2),               # Good Friday
        _nth_weekday(year, 5, 0, -1),                   # Memorial Day
        _observed(date(year, 7, 4)),                    # Independence Day
        _nth_weekday(year, 9, 0, 1),                    # Labor Day
        _nth_weekday(year, 11, 3, 4),                   # Thanksgiving
        _observed(date(year, 12, 25)),                  # Christmas
    }
    # Juneteenth became a market holiday in 2022.
    if year >= 2022:
        days.add(_observed(date(year, 6, 19)))
    return frozenset(days)


def is_trading_day(d: date) -> bool:
    return d.weekday() < 5 and d not in nyse_holidays(d.year)


def trading_days(start: date, end: date) -> list[date]:
    """Every NYSE session in [start, end], ascending."""
    out, d = [], start
    while d <= end:
        if is_trading_day(d):
            out.append(d)
        d += timedelta(days=1)
    return out


def sessions_between(start: date, end: date) -> int:
    """Sessions in (start, end] — the natural unit for "days behind"."""
    if end <= start:
        return 0
    return len(trading_days(start + timedelta(days=1), end))


def previous_trading_day(d: date) -> date:
    d -= timedelta(days=1)
    while not is_trading_day(d):
        d -= timedelta(days=1)
    return d
