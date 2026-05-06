"""Core capture logic: filter, handler, session lifecycle.

Filtering happens at the *logger* level (not just on our in-memory handler),
so that during a capture session even ``home-assistant.log`` only receives
records of the selected devices — keeping the main log file clean.

The buffer lives in RAM and is flushed to disk only on:
    - periodic timer (default every 4h)
    - manual stop / auto-stop / unload
    - HA shutdown (EVENT_HOMEASSISTANT_STOP)
    - safety cap reached (DEFAULT_BUFFER_MAX_BYTES)

This significantly reduces SD-card wear compared to having ``zigpy: debug``
written continuously to ``home-assistant.log``.
"""
from __future__ import annotations

import asyncio
import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from homeassistant.components import persistent_notification
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_call_later
from homeassistant.util import dt as dt_util

from .const import (
    CAPTURE_DIR_NAME,
    CAPTURE_LOGGERS,
    DEFAULT_BUFFER_MAX_BYTES,
    DEFAULT_FLUSH_INTERVAL_MINUTES,
    DEFAULT_TAIL_LINES,
    DOMAIN,
    EVENT_SESSION_CHANGED,
    LOG_FORMAT,
    MAX_DURATION_SECONDS,
    MIN_DURATION_SECONDS,
    NOTIFICATION_ID,
    TAIL_FILE_BYTES,
)

_LOGGER = logging.getLogger(__name__)


class IeeeFilter(logging.Filter):
    """Pass only log records that mention one of the target IEEE/NWK strings.

    Matching is case-insensitive substring on the formatted message. We add
    multiple variants per device (with/without colons for the IEEE, plus the
    NWK in ``0xABCD`` form) because different zigpy/bellows loggers print
    addresses in different formats.
    """

    def __init__(self, needles: set[str]) -> None:
        super().__init__()
        self._lock = threading.Lock()
        self._needles: set[str] = {n.lower() for n in needles if n}

    def update_needles(self, needles: set[str]) -> None:
        with self._lock:
            self._needles = {n.lower() for n in needles if n}

    def get_needles(self) -> set[str]:
        with self._lock:
            return set(self._needles)

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage().lower()
        except Exception:
            return False
        with self._lock:
            for needle in self._needles:
                if needle in msg:
                    return True
        return False


class MemoryBufferHandler(logging.Handler):
    """Append records to an in-RAM buffer; write to disk only on demand."""

    def __init__(
        self,
        file_path: Path,
        max_bytes: int = DEFAULT_BUFFER_MAX_BYTES,
    ) -> None:
        super().__init__()
        self.file_path = file_path
        self.max_bytes = max_bytes
        self.buffer: list[str] = []
        self.size = 0
        self._lock = threading.Lock()

    def emit(self, record: logging.LogRecord) -> None:
        try:
            line = self.format(record) + "\n"
            with self._lock:
                self.buffer.append(line)
                self.size += len(line)
                if self.size >= self.max_bytes:
                    # Safety net: flush synchronously from the logging thread
                    # to avoid OOM if the buffer ever grows beyond the cap.
                    self._flush_locked()
        except Exception:
            self.handleError(record)

    def flush_to_disk(self) -> None:
        with self._lock:
            self._flush_locked()

    @property
    def buffered_bytes(self) -> int:
        with self._lock:
            return self.size

    def tail_lines(self, n: int) -> list[str]:
        """Snapshot the last n in-memory lines, stripped of trailing newline."""
        with self._lock:
            if not self.buffer:
                return []
            return [s.rstrip("\n") for s in self.buffer[-n:]]

    def _flush_locked(self) -> None:
        if not self.buffer:
            return
        try:
            self.file_path.parent.mkdir(parents=True, exist_ok=True)
            with self.file_path.open("a", encoding="utf-8") as fh:
                fh.writelines(self.buffer)
        finally:
            self.buffer.clear()
            self.size = 0


@dataclass
class ZhaCaptureSession:
    """Runtime state of an active capture."""

    device_ids: list[str]
    device_ieees: list[str]
    handler: MemoryBufferHandler
    log_filter: IeeeFilter
    original_levels: dict[str, int]
    file_path: Path
    started_at: datetime
    expires_at: datetime
    flush_interval_minutes: int
    flush_unsub: Any | None = None
    stop_unsub: Any | None = None
    device_names: list[str] = field(default_factory=list)


def _build_needles(device_proxies: list[Any]) -> set[str]:
    """All match strings (IEEE colon/no-colon, NWK 0xABCD) for the filter."""
    needles: set[str] = set()
    for proxy in device_proxies:
        device = proxy.device
        ieee_str = str(device.ieee).lower()
        needles.add(ieee_str)
        needles.add(ieee_str.replace(":", ""))
        nwk = getattr(device, "nwk", None)
        if nwk is not None:
            try:
                nwk_int = int(nwk)
            except (TypeError, ValueError):
                pass
            else:
                needles.add(f"0x{nwk_int:04x}")
    return needles


async def _resolve_devices(
    hass: HomeAssistant, device_ids: list[str]
) -> list[Any]:
    """Resolve HA device IDs to ZHA device proxies.

    Raises ValueError if any device_id does not correspond to a ZHA device.
    """
    from homeassistant.components.zha.helpers import async_get_zha_device_proxy

    proxies: list[Any] = []
    for device_id in device_ids:
        try:
            proxy = async_get_zha_device_proxy(hass, device_id)
        except Exception as err:
            raise ValueError(
                f"Device {device_id} is not a valid ZHA device: {err}"
            ) from err
        if proxy is None:
            raise ValueError(f"Device {device_id} not found in ZHA")
        proxies.append(proxy)
    return proxies


def _device_display_name(proxy: Any) -> str:
    device = proxy.device
    name = getattr(device, "name", None) or getattr(device, "manufacturer", None)
    if not name:
        name = str(getattr(device, "ieee", "?"))
    return str(name)


async def start_capture(
    hass: HomeAssistant,
    device_ids: list[str],
    end_time: datetime,
    flush_interval_minutes: int = DEFAULT_FLUSH_INTERVAL_MINUTES,
    replace_existing: bool = False,
) -> ZhaCaptureSession:
    """Start a capture session.

    Raises RuntimeError if a session is already active and replace_existing is
    false. Raises ValueError on invalid input (no devices, non-ZHA device).
    """
    domain_data = hass.data.setdefault(DOMAIN, {})
    lock: asyncio.Lock = domain_data.setdefault("lock", asyncio.Lock())

    async with lock:
        existing: ZhaCaptureSession | None = domain_data.get("session")
        if existing is not None:
            if not replace_existing:
                raise RuntimeError(
                    "A capture session is already active — "
                    "set replace_existing=true to replace it"
                )
            await _stop_capture_locked(hass, existing, reason="replaced")

        if not device_ids:
            raise ValueError("No devices selected")

        proxies = await _resolve_devices(hass, device_ids)
        ieees = [str(p.device.ieee).lower() for p in proxies]
        names = [_device_display_name(p) for p in proxies]
        needles = _build_needles(proxies)

        now = dt_util.utcnow()
        if end_time.tzinfo is None:
            # Naïve datetime → assume HA local timezone.
            local_tz = dt_util.get_default_time_zone()
            end_time = end_time.replace(tzinfo=local_tz)
        end_time_utc = dt_util.as_utc(end_time)
        delay_s = (end_time_utc - now).total_seconds()
        delay_s = max(MIN_DURATION_SECONDS, min(MAX_DURATION_SECONDS, delay_s))
        expires_at = now + timedelta(seconds=delay_s)

        capture_dir = Path(hass.config.path(DOMAIN)) / CAPTURE_DIR_NAME
        timestamp = dt_util.now().strftime("%Y%m%d_%H%M%S")
        file_path = capture_dir / f"zha_{timestamp}.log"

        log_filter = IeeeFilter(needles)
        handler = MemoryBufferHandler(file_path)
        handler.setFormatter(logging.Formatter(LOG_FORMAT))
        handler.setLevel(logging.DEBUG)

        original_levels: dict[str, int] = {}
        for logger_name in CAPTURE_LOGGERS:
            logger = logging.getLogger(logger_name)
            original_levels[logger_name] = logger.level
            logger.setLevel(logging.DEBUG)
            logger.addFilter(log_filter)
            logger.addHandler(handler)

        flush_interval_s = max(60, int(flush_interval_minutes) * 60)

        session = ZhaCaptureSession(
            device_ids=list(device_ids),
            device_ieees=ieees,
            handler=handler,
            log_filter=log_filter,
            original_levels=original_levels,
            file_path=file_path,
            started_at=now,
            expires_at=expires_at,
            flush_interval_minutes=int(flush_interval_minutes),
            device_names=names,
        )

        async def _periodic_flush(_now: Any) -> None:
            current = domain_data.get("session")
            if current is not session:
                return
            try:
                await hass.async_add_executor_job(handler.flush_to_disk)
            except Exception as err:
                _LOGGER.error("Periodic flush failed: %s", err)
            try:
                fresh_proxies = await _resolve_devices(hass, session.device_ids)
                fresh_needles = _build_needles(fresh_proxies)
                if fresh_needles != log_filter.get_needles():
                    log_filter.update_needles(fresh_needles)
                    _LOGGER.debug(
                        "Refreshed filter needles after rejoin check"
                    )
            except Exception as err:
                _LOGGER.debug(
                    "Could not refresh NWK during periodic flush: %s", err
                )
            session.flush_unsub = async_call_later(
                hass, flush_interval_s, _periodic_flush
            )

        async def _auto_stop(_now: Any) -> None:
            current = domain_data.get("session")
            if current is not session:
                return
            await stop_capture(hass, reason="expired")

        session.flush_unsub = async_call_later(
            hass, flush_interval_s, _periodic_flush
        )
        session.stop_unsub = async_call_later(hass, delay_s, _auto_stop)

        domain_data["session"] = session

        _LOGGER.info(
            "ZHA capture started for %d device(s): %s — expires at %s, file: %s",
            len(ieees),
            ieees,
            expires_at.isoformat(),
            file_path,
        )

        _update_notification(hass, session, status="started")
        hass.bus.async_fire(
            EVENT_SESSION_CHANGED,
            {"action": "started", "device_ieees": ieees},
        )

        return session


async def stop_capture(hass: HomeAssistant, reason: str = "manual") -> bool:
    """Stop the active session if any. Returns True if something was stopped."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    lock: asyncio.Lock = domain_data.setdefault("lock", asyncio.Lock())
    async with lock:
        session: ZhaCaptureSession | None = domain_data.get("session")
        if session is None:
            return False
        await _stop_capture_locked(hass, session, reason=reason)
        return True


async def _stop_capture_locked(
    hass: HomeAssistant,
    session: ZhaCaptureSession,
    reason: str,
) -> None:
    """Stop helper assuming the lock is already held."""
    domain_data = hass.data.setdefault(DOMAIN, {})

    if session.flush_unsub:
        try:
            session.flush_unsub()
        except Exception:
            pass
        session.flush_unsub = None
    if session.stop_unsub:
        try:
            session.stop_unsub()
        except Exception:
            pass
        session.stop_unsub = None

    for logger_name, original_level in session.original_levels.items():
        logger = logging.getLogger(logger_name)
        try:
            logger.removeFilter(session.log_filter)
        except Exception:
            pass
        try:
            logger.removeHandler(session.handler)
        except Exception:
            pass
        try:
            logger.setLevel(original_level)
        except Exception:
            pass

    try:
        await hass.async_add_executor_job(session.handler.flush_to_disk)
    except Exception as err:
        _LOGGER.error("Final flush failed: %s", err)

    if domain_data.get("session") is session:
        domain_data["session"] = None

    _LOGGER.info(
        "ZHA capture ended (%s) — file: %s", reason, session.file_path
    )

    _update_notification(hass, session, status="ended", reason=reason)
    hass.bus.async_fire(
        EVENT_SESSION_CHANGED,
        {"action": "stopped", "reason": reason},
    )


@callback
def _update_notification(
    hass: HomeAssistant,
    session: ZhaCaptureSession,
    status: str,
    reason: str | None = None,
) -> None:
    if status == "started":
        local_expires = dt_util.as_local(session.expires_at)
        msg = (
            f"Cattura attiva su {len(session.device_ieees)} device.\n"
            f"Scade alle {local_expires.strftime('%H:%M')}.\n"
            f"File: `{session.file_path}`"
        )
        title = "ZHA Debug Capture — attiva"
    else:
        size = (
            session.file_path.stat().st_size
            if session.file_path.exists()
            else 0
        )
        msg = (
            f"Cattura terminata ({reason}).\n"
            f"File: `{session.file_path}` ({size} byte)"
        )
        title = "ZHA Debug Capture — conclusa"
    persistent_notification.async_create(
        hass, msg, title=title, notification_id=NOTIFICATION_ID
    )


def session_status(hass: HomeAssistant) -> dict[str, Any]:
    """Return a JSON-serialisable snapshot of the active session, or {active: false}."""
    domain_data = hass.data.get(DOMAIN, {})
    session: ZhaCaptureSession | None = domain_data.get("session")
    if session is None:
        return {"active": False}
    return {
        "active": True,
        "device_ids": list(session.device_ids),
        "device_ieees": list(session.device_ieees),
        "device_names": list(session.device_names),
        "started_at": session.started_at.isoformat(),
        "expires_at": session.expires_at.isoformat(),
        "buffered_bytes": session.handler.buffered_bytes,
        "file_path": str(session.file_path),
        "flush_interval_minutes": session.flush_interval_minutes,
    }


def _tail_session_sync(hass: HomeAssistant, n: int) -> dict[str, Any]:
    """Synchronously gather a tail of the active capture (file + buffer).

    Reads at most TAIL_FILE_BYTES from the end of the on-disk file (skipping
    the possibly-partial first line) and concatenates them with the in-memory
    buffer. The combined list is then trimmed to n lines.
    """
    domain_data = hass.data.get(DOMAIN, {})
    session: ZhaCaptureSession | None = domain_data.get("session")
    if session is None:
        return {"active": False, "lines": []}

    file_lines: list[str] = []
    if session.file_path.exists():
        try:
            with session.file_path.open("rb") as fh:
                fh.seek(0, 2)
                size = fh.tell()
                read_from = max(0, size - TAIL_FILE_BYTES)
                fh.seek(read_from)
                content = fh.read().decode("utf-8", errors="replace")
            lines = content.splitlines()
            if read_from > 0 and lines:
                # First line may be truncated by the seek; drop it.
                lines = lines[1:]
            file_lines = lines
        except OSError as err:
            _LOGGER.debug("Tail file read failed: %s", err)

    buffer_lines = session.handler.tail_lines(n)
    combined = (file_lines + buffer_lines)[-n:]
    return {
        "active": True,
        "lines": combined,
        "buffered_bytes": session.handler.buffered_bytes,
        "expires_at": session.expires_at.isoformat(),
        "file_path": str(session.file_path),
    }


async def tail_session(
    hass: HomeAssistant, n: int = DEFAULT_TAIL_LINES
) -> dict[str, Any]:
    """Return a JSON-serialisable tail of the active session."""
    return await hass.async_add_executor_job(_tail_session_sync, hass, n)


async def delete_capture_file(hass: HomeAssistant, filename: str) -> None:
    """Delete a saved capture file by name. Validates against path traversal,
    refuses to delete the file of the active session.
    """
    capture_dir = (Path(hass.config.path(DOMAIN)) / CAPTURE_DIR_NAME).resolve()
    target_name = Path(filename).name
    if not target_name.startswith("zha_") or not target_name.endswith(".log"):
        raise ValueError(f"Invalid capture filename: {filename}")
    target = (capture_dir / target_name).resolve()
    if not target.is_relative_to(capture_dir):
        raise ValueError(f"Invalid capture filename: {filename}")
    if not target.exists():
        raise ValueError(f"Capture file not found: {target_name}")

    domain_data = hass.data.get(DOMAIN, {})
    session: ZhaCaptureSession | None = domain_data.get("session")
    if session is not None and session.file_path.resolve() == target:
        raise ValueError(
            "Cannot delete the file of the active capture — stop the session first"
        )

    await hass.async_add_executor_job(target.unlink)
    _LOGGER.info("Deleted capture file: %s", target)


def list_capture_files(hass: HomeAssistant) -> list[dict[str, Any]]:
    capture_dir = Path(hass.config.path(DOMAIN)) / CAPTURE_DIR_NAME
    if not capture_dir.exists():
        return []
    out: list[dict[str, Any]] = []
    for f in sorted(capture_dir.glob("zha_*.log"), reverse=True):
        try:
            stat = f.stat()
        except OSError:
            continue
        out.append(
            {
                "filename": f.name,
                "size_bytes": stat.st_size,
                "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            }
        )
    return out
