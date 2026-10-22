"""When the daily predictions should run: noon Eastern on weekends and US
federal holidays (when the NBA plays afternoon games), 5 p.m. on other days.

Standard library only, so the workflow can ask before installing anything.

Usage:
    python -m ml.schedule_time            # prints go=true or go=false (for $GITHUB_OUTPUT)
"""

import datetime
import sys
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
WEEKEND_HOUR = 12
WEEKDAY_HOUR = 17
WINDOW = 1  # also go up to this many hours late, in case GitHub starts the run late


def _nth_weekday(year, month, weekday, n):
    """The nth `weekday` (Mon=0) of a month; n=-1 is the last."""
    if n > 0:
        first = datetime.date(year, month, 1)
        return first + datetime.timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))
    last = datetime.date(year, month + 1, 1) - datetime.timedelta(days=1) if month < 12 else datetime.date(year, 12, 31)
    return last - datetime.timedelta(days=(last.weekday() - weekday) % 7)


def us_holidays(year):
    """US federal holidays, on the day itself."""
    d = datetime.date
    return {
        d(year, 1, 1),                    # New Year's Day
        _nth_weekday(year, 1, 0, 3),      # Martin Luther King Jr. Day
        _nth_weekday(year, 2, 0, 3),      # Presidents' Day
        _nth_weekday(year, 5, 0, -1),     # Memorial Day
        d(year, 6, 19),                   # Juneteenth
        d(year, 7, 4),                    # Independence Day
        _nth_weekday(year, 9, 0, 1),      # Labor Day
        _nth_weekday(year, 10, 0, 2),     # Columbus Day
        d(year, 11, 11),                  # Veterans Day
        _nth_weekday(year, 11, 3, 4),     # Thanksgiving
        d(year, 12, 25),                  # Christmas
    }


def due_hour(day):
    """The Eastern hour predictions are made on `day`."""
    return WEEKEND_HOUR if day.weekday() >= 5 or day in us_holidays(day.year) else WEEKDAY_HOUR


def is_due(now=None):
    now = now or datetime.datetime.now(ET)
    hour = due_hour(now.date())
    return hour <= now.hour <= hour + WINDOW


if __name__ == "__main__":
    now = datetime.datetime.now(ET)
    print(f"go={'true' if is_due(now) else 'false'}")
    # $GITHUB_OUTPUT only takes name=value lines, so the explanation goes to the log
    print(f"{now:%a %Y-%m-%d %H:%M} ET; today's run is at {due_hour(now.date())}:00", file=sys.stderr)
