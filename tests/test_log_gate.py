"""Tests for log_gate: the root-handler filter that keeps home-assistant.log
clean while a capture session has bumped loggers to DEBUG.

Run with:  python3 -m unittest discover -s tests
No Home Assistant needed: log_gate is stdlib-only and is loaded by path
because the package __init__ imports HA.
"""
from __future__ import annotations

import importlib.util
import logging
import sys
import unittest
from pathlib import Path

_MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "custom_components"
    / "zha_debug_capture"
    / "log_gate.py"
)
_spec = importlib.util.spec_from_file_location("log_gate", _MODULE_PATH)
log_gate = importlib.util.module_from_spec(_spec)
sys.modules["log_gate"] = log_gate
_spec.loader.exec_module(log_gate)

LevelGateFilter = log_gate.LevelGateFilter
raise_loggers_to_debug = log_gate.raise_loggers_to_debug
snapshot_levels = log_gate.snapshot_levels


class _ListHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


class _NoOpSetLevelLogger(logging.Logger):
    """Mimics HA's HassLogger for names overridden in the logger integration."""

    def setLevel(self, level):  # noqa: N802
        return


_COUNTER = 0


def _fresh_namespace() -> str:
    global _COUNTER
    _COUNTER += 1
    return f"zdc_test{_COUNTER}"


class LevelGateFilterTest(unittest.TestCase):
    """The filter sits on the "root" handler. Here the root is played by a
    private top-level logger so tests do not touch the real root."""

    def setUp(self) -> None:
        self.ns = _fresh_namespace()
        self.root = logging.getLogger(self.ns)
        self.root.setLevel(logging.INFO)
        self.root.propagate = False
        self.sink = _ListHandler()
        self.root.addHandler(self.sink)
        self.zcl = logging.getLogger(f"{self.ns}.zigpy.zcl")
        self.zcl.setLevel(logging.DEBUG)

    def tearDown(self) -> None:
        self.root.removeHandler(self.sink)

    def _names(self) -> list[tuple[str, int]]:
        return [(r.name, r.levelno) for r in self.sink.records]

    def test_without_filter_debug_reaches_root_handler(self) -> None:
        # Reproduces the bug: parent logger level is ignored on propagation.
        self.zcl.debug("frame")
        self.assertEqual(self._names(), [(self.zcl.name, logging.DEBUG)])

    def test_debug_below_threshold_is_dropped(self) -> None:
        self.sink.addFilter(LevelGateFilter({self.zcl.name: logging.INFO}))
        self.zcl.debug("frame")
        self.assertEqual(self._names(), [])

    def test_records_at_or_above_threshold_pass(self) -> None:
        self.sink.addFilter(LevelGateFilter({self.zcl.name: logging.INFO}))
        self.zcl.info("hello")
        self.zcl.warning("careful")
        self.assertEqual(
            self._names(),
            [(self.zcl.name, logging.INFO), (self.zcl.name, logging.WARNING)],
        )

    def test_child_of_gated_logger_is_gated(self) -> None:
        self.sink.addFilter(LevelGateFilter({self.zcl.name: logging.INFO}))
        child = logging.getLogger(f"{self.zcl.name}.cluster")
        child.debug("frame")
        child.error("boom")
        self.assertEqual(self._names(), [(child.name, logging.ERROR)])

    def test_unrelated_logger_untouched(self) -> None:
        self.sink.addFilter(LevelGateFilter({self.zcl.name: logging.INFO}))
        other = logging.getLogger(f"{self.ns}.zigpy.zclx")  # prefix, not child
        other.setLevel(logging.DEBUG)
        other.debug("mine")
        self.assertEqual(self._names(), [(other.name, logging.DEBUG)])

    def test_most_specific_prefix_wins(self) -> None:
        parent = logging.getLogger(f"{self.ns}.zigpy")
        parent.setLevel(logging.DEBUG)
        self.sink.addFilter(
            LevelGateFilter(
                {parent.name: logging.WARNING, self.zcl.name: logging.DEBUG}
            )
        )
        self.zcl.debug("kept: zcl threshold is DEBUG")
        sibling = logging.getLogger(f"{self.ns}.zigpy.zdo")
        sibling.debug("dropped: falls under zigpy WARNING")
        self.assertEqual(self._names(), [(self.zcl.name, logging.DEBUG)])


class RaiseLoggersToDebugTest(unittest.TestCase):
    def setUp(self) -> None:
        self.ns = _fresh_namespace()
        root = logging.getLogger(self.ns)
        root.setLevel(logging.WARNING)
        root.propagate = False

    def test_returns_own_levels_and_effective_thresholds(self) -> None:
        name = f"{self.ns}.zigpy.zcl"
        logger = logging.getLogger(name)  # NOTSET, inherits WARNING
        result = raise_loggers_to_debug([name])
        self.assertEqual(logger.level, logging.DEBUG)
        self.assertEqual(result.original_levels, {name: logging.NOTSET})
        self.assertEqual(result.thresholds, {name: logging.WARNING})
        self.assertEqual(result.blocked, [])

    def test_thresholds_are_taken_before_any_bump(self) -> None:
        parent = f"{self.ns}.zigpy"
        child = f"{self.ns}.zigpy.zcl"
        logging.getLogger(parent)
        logging.getLogger(child)
        result = raise_loggers_to_debug([parent, child])
        # child must not see the parent's fresh DEBUG as its old effective level
        self.assertEqual(result.thresholds[child], logging.WARNING)

    def test_snapshot_does_not_touch_levels_and_feeds_the_bump(self) -> None:
        name = f"{self.ns}.zigpy.zcl"
        logger = logging.getLogger(name)
        snap = snapshot_levels([name])
        self.assertEqual(logger.level, logging.NOTSET)
        self.assertEqual(snap.thresholds, {name: logging.WARNING})
        result = raise_loggers_to_debug([name], snap)
        self.assertIs(result, snap)
        self.assertEqual(logger.level, logging.DEBUG)

    def test_detects_logger_whose_setlevel_is_ignored(self) -> None:
        name = f"{self.ns}.zigpy.zcl"
        blocked = _NoOpSetLevelLogger(name)
        blocked.parent = logging.getLogger(self.ns)
        logging.Logger.manager.loggerDict[name] = blocked
        try:
            result = raise_loggers_to_debug([name])
        finally:
            del logging.Logger.manager.loggerDict[name]
        self.assertEqual(result.blocked, [name])
        self.assertEqual(result.thresholds[name], logging.WARNING)


if __name__ == "__main__":
    unittest.main()
