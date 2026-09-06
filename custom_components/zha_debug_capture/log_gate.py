"""Keep ``home-assistant.log`` clean while a capture session is running.

Pure stdlib, no Home Assistant imports — this module is unit-tested
outside HA (see ``tests/test_log_gate.py``).

Why this exists
---------------
A capture session raises the loggers in ``CAPTURE_LOGGERS`` to DEBUG so
that our in-memory handler receives every frame. But Python's logging
propagates a record from the *originating* logger straight up to every
ancestor's handlers, and it never consults the ancestors' levels on the
way: only the originating logger's effective level and each handler's own
level matter. HA's root handler (``HomeAssistantQueueHandler``, which feeds
the log file and stderr) has no level set, so every DEBUG record we
unlock would also land in ``home-assistant.log``, unfiltered by device.

``HomeAssistantQueueHandler.handle()`` explicitly runs the handler's
filters before queueing a record, so a filter installed on the root
handlers is the supported hook. :class:`LevelGateFilter` drops records
from the raised loggers (and their children) whose level is below what
the logger's *effective* level was before we touched it. Everything else
behaves exactly as before the session: WARNING/ERROR still reach the main
log, a user who already configured ``zigpy.zcl: debug`` keeps seeing it.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

_CACHE_MAX = 4096


class LevelGateFilter(logging.Filter):
    """Drop records below a per-namespace level threshold.

    ``thresholds`` maps a logger name to the minimum ``levelno`` allowed
    through for that logger and all of its descendants. The most specific
    matching name wins. Loggers outside every namespace are untouched.

    The filter runs for every record HA emits, so lookups are a dict get
    on ``record.name`` backed by a bounded cache; no regexes.
    """

    def __init__(self, thresholds: dict[str, int]) -> None:
        super().__init__()
        self._thresholds = dict(thresholds)
        self._cache: dict[str, int | None] = {}

    def _threshold_for(self, name: str) -> int | None:
        cache = self._cache
        try:
            return cache[name]
        except KeyError:
            pass
        best_len = -1
        threshold: int | None = None
        for prefix, level in self._thresholds.items():
            if name == prefix or name.startswith(prefix + "."):
                if len(prefix) > best_len:
                    best_len = len(prefix)
                    threshold = level
        if len(cache) < _CACHE_MAX:
            cache[name] = threshold
        return threshold

    def filter(self, record: logging.LogRecord) -> bool:
        threshold = self._threshold_for(record.name)
        if threshold is None:
            return True
        return record.levelno >= threshold


@dataclass
class RaisedLoggers:
    """Result of :func:`raise_loggers_to_debug`."""

    original_levels: dict[str, int] = field(default_factory=dict)
    """Each logger's *own* level before the bump — restore with setLevel."""

    thresholds: dict[str, int] = field(default_factory=dict)
    """Each logger's *effective* level before the bump — feed to the gate."""

    blocked: list[str] = field(default_factory=list)
    """Loggers whose ``setLevel`` silently refused the change."""


def snapshot_levels(names: list[str] | tuple[str, ...]) -> RaisedLoggers:
    """Record each logger's own and effective level without changing it.

    Taken for *all* names before any bump, so a child listed next to its
    parent does not read the parent's fresh DEBUG as its old effective
    level. Feed ``thresholds`` to :class:`LevelGateFilter` and install the
    gate on the root handlers *before* calling :func:`raise_loggers_to_debug`.
    """
    result = RaisedLoggers()
    for name in names:
        logger = logging.getLogger(name)
        result.original_levels[name] = logger.level
        result.thresholds[name] = logger.getEffectiveLevel()
    return result


def raise_loggers_to_debug(
    names: list[str] | tuple[str, ...],
    snapshot: RaisedLoggers | None = None,
) -> RaisedLoggers:
    """Set every named logger to DEBUG, remembering what to restore.

    Pass the :func:`snapshot_levels` result if the gate was already
    installed from it; otherwise the snapshot is taken here.

    HA's ``logger`` integration installs a Logger subclass whose
    ``setLevel`` is a no-op for names the user overrode in ``logger:`` or
    via ``logger.set_level``. Those loggers are reported in ``blocked`` so
    the caller can warn that the capture will miss them.
    """
    result = snapshot if snapshot is not None else snapshot_levels(names)
    for name in names:
        logger = logging.getLogger(name)
        logger.setLevel(logging.DEBUG)
        if logger.level != logging.DEBUG:
            result.blocked.append(name)
    return result


def install_root_gate(gate: LevelGateFilter) -> list[logging.Handler]:
    """Attach ``gate`` to every root handler; return the handlers touched."""
    touched: list[logging.Handler] = []
    for handler in logging.root.handlers[:]:
        handler.addFilter(gate)
        touched.append(handler)
    return touched


def remove_root_gate(
    gate: LevelGateFilter, handlers: list[logging.Handler]
) -> None:
    """Detach ``gate`` from the handlers it was installed on."""
    for handler in handlers:
        try:
            handler.removeFilter(gate)
        except Exception:  # noqa: BLE001 — stop must never fail partially
            pass
