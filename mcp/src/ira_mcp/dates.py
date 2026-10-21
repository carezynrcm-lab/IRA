"""Forgiving date/time parsing so spoken requests ("next Friday at 3:30") just work."""

from __future__ import annotations

import os
import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

# Hospitals work in local time; serverless machines run in UTC.
TZ = ZoneInfo(os.environ.get("APP_TIMEZONE", "Asia/Kolkata"))

WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august",
          "september", "october", "november", "december"]
PARTS_OF_DAY = {
    "morning": ("00:00", "12:00"),
    "afternoon": ("12:00", "17:00"),
    "evening": ("17:00", "24:00"),
}


def today() -> date:
    return datetime.now(TZ).date()


def _weekday_index(word: str) -> int | None:
    for i, name in enumerate(WEEKDAYS):
        if word == name or (len(word) >= 3 and name.startswith(word)):
            return i
    return None


def _month_index(word: str) -> int | None:
    for i, name in enumerate(MONTHS):
        if word == name or (len(word) >= 3 and name.startswith(word)):
            return i + 1
    return None


def _future(d: date, base: date) -> date:
    """A day/month without a year means the next time that date comes round."""
    return d if d >= base else d.replace(year=d.year + 1)


def parse_date(value: str | None, base: date | None = None) -> date:
    """Accepts YYYY-MM-DD, today/tomorrow, 'in 3 days', weekdays, '23 Oct', 'Oct 23', '23/10'."""
    base = base or today()
    if value is None or not str(value).strip():
        return base
    t = re.sub(r"[,]", " ", str(value).strip().lower())
    t = re.sub(r"\s+", " ", t)
    t = re.sub(r"(\d+)(st|nd|rd|th)\b", r"\1", t)

    if t in ("today", "now", "tonight"):
        return base
    if t in ("tomorrow", "tmrw", "tmr"):
        return base + timedelta(days=1)
    if t in ("day after tomorrow", "the day after tomorrow", "overmorrow"):
        return base + timedelta(days=2)
    if t == "yesterday":
        return base - timedelta(days=1)
    if m := re.fullmatch(r"in (\d+) days?", t):
        return base + timedelta(days=int(m.group(1)))
    if m := re.fullmatch(r"in (\d+) weeks?", t):
        return base + timedelta(weeks=int(m.group(1)))
    if t in ("next week",):
        return base + timedelta(days=7 - base.weekday())  # coming Monday

    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", t):
        return date.fromisoformat(t)

    if m := re.fullmatch(r"(?:(this|next|coming) )?([a-z]+)", t):
        idx = _weekday_index(m.group(2))
        if idx is not None:
            ahead = (idx - base.weekday()) % 7
            if m.group(1) == "next" and ahead == 0:
                ahead = 7
            return base + timedelta(days=ahead)

    # "23 oct", "23 october 2026", "oct 23", "october 23 2026"
    if m := re.fullmatch(r"(\d{1,2}) ([a-z]+)(?: (\d{4}))?", t):
        month = _month_index(m.group(2))
        if month:
            d = date(int(m.group(3) or base.year), month, int(m.group(1)))
            return d if m.group(3) else _future(d, base)
    if m := re.fullmatch(r"([a-z]+) (\d{1,2})(?: (\d{4}))?", t):
        month = _month_index(m.group(1))
        if month:
            d = date(int(m.group(3) or base.year), month, int(m.group(2)))
            return d if m.group(3) else _future(d, base)

    # Day-first numeric dates (23/10, 23-10-2026), as used in India and the UK.
    if m := re.fullmatch(r"(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?", t):
        year = int(m.group(3)) if m.group(3) else base.year
        if year < 100:
            year += 2000
        d = date(year, int(m.group(2)), int(m.group(1)))
        return d if m.group(3) else _future(d, base)

    raise ValueError(
        f"I couldn't understand the date “{value}”. Try 'today', 'tomorrow', a weekday like 'Friday', "
        "'23 October', or YYYY-MM-DD."
    )


def parse_time(value: str) -> str:
    """Accepts '9', '9am', '9:30 am', '14:00', 'noon', '3.30 pm'. Returns 'HH:MM'.

    Without am/pm, 1–7 is read as afternoon (clinic hours), e.g. '3:30' → 15:30.
    """
    t = str(value).strip().lower().replace(".", ":")
    t = re.sub(r"\s+", " ", t)
    t = t.replace("a:m:", "am").replace("p:m:", "pm").replace("a:m", "am").replace("p:m", "pm")
    if t in ("noon", "midday", "12 noon"):
        return "12:00"
    m = re.fullmatch(r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?: o'?clock)?", t)
    if not m:
        raise ValueError(f"I couldn't understand the time “{value}”. Try something like '9:30 am' or '14:00'.")
    hour, minute, meridiem = int(m.group(1)), int(m.group(2) or 0), m.group(3)
    if meridiem == "pm" and hour < 12:
        hour += 12
    elif meridiem == "am" and hour == 12:
        hour = 0
    elif meridiem is None and 1 <= hour <= 7:
        hour += 12
    if hour > 23 or minute > 59:
        raise ValueError(f"“{value}” isn't a valid time.")
    return f"{hour:02d}:{minute:02d}"


def in_part_of_day(hhmm: str, part: str | None) -> bool:
    if not part or part == "any":
        return True
    start, end = PARTS_OF_DAY[part]
    return start <= hhmm < end


def fmt_time(hhmm: str) -> str:
    h, m = map(int, hhmm.split(":"))
    return f"{h % 12 or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"


def fmt_date(d: date | str, base: date | None = None) -> str:
    """'today (Wednesday, 21 October)', 'tomorrow (…)', or 'Friday, 23 October'."""
    if isinstance(d, str):
        d = date.fromisoformat(d)
    base = base or today()
    label = f"{d.strftime('%A')}, {d.day} {d.strftime('%B')}"
    if d.year != base.year:
        label += f" {d.year}"
    delta = (d - base).days
    if delta == 0:
        return f"today ({label})"
    if delta == 1:
        return f"tomorrow ({label})"
    if delta == -1:
        return f"yesterday ({label})"
    return label


def on_date(d: date | str, base: date | None = None) -> str:
    """Speakable 'on <date>': 'tomorrow (Thursday, 22 October)' or 'on Friday, 23 October'."""
    label = fmt_date(d, base)
    return label if label.startswith(("today", "tomorrow", "yesterday")) else f"on {label}"


def now_hhmm() -> str:
    return datetime.now(TZ).strftime("%H:%M")
