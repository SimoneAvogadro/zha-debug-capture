"""Constants for the ZHA Debug Capture integration."""
from __future__ import annotations

DOMAIN = "zha_debug_capture"
VERSION = "0.1.5"

URL_BASE = f"/{DOMAIN}"
PANEL_URL_PATH = DOMAIN.replace("_", "-")
PANEL_ELEMENT_NAME = f"{PANEL_URL_PATH}-panel"

CAPTURE_DIR_NAME = "captures"

SERVICE_START = "start"
SERVICE_STOP = "stop"
SERVICE_STATUS = "status"
SERVICE_LIST_CAPTURES = "list_captures"
SERVICE_TAIL = "tail"
SERVICE_DELETE_CAPTURE = "delete_capture"

ATTR_DEVICES = "devices"
ATTR_END_TIME = "end_time"
ATTR_FLUSH_INTERVAL_MINUTES = "flush_interval_minutes"
ATTR_REPLACE_EXISTING = "replace_existing"
ATTR_LINES = "lines"
ATTR_FILENAME = "filename"

DEFAULT_TAIL_LINES = 200
MAX_TAIL_LINES = 2000
TAIL_FILE_BYTES = 256 * 1024

EVENT_SESSION_CHANGED = f"{DOMAIN}_session_changed"

OPTION_SHOW_IN_SIDEBAR = "show_in_sidebar"
DEFAULT_SHOW_IN_SIDEBAR = True

DEFAULT_FLUSH_INTERVAL_MINUTES = 240
MIN_DURATION_SECONDS = 60
MAX_DURATION_SECONDS = 7 * 86400

DEFAULT_BUFFER_MAX_BYTES = 50 * 1024 * 1024

NOTIFICATION_ID = f"{DOMAIN}_session"

CAPTURE_LOGGERS: tuple[str, ...] = (
    "zigpy.zcl",
    "zigpy.application",
    "zigpy.zdo",
    "bellows.zigbee.application",
    "zigpy_znp.zigbee.application",
    "zigpy_deconz.zigbee.application",
    "zigpy_xbee.zigbee.application",
    "homeassistant.components.zha",
)

LOG_FORMAT = "%(asctime)s %(levelname)s [%(zha_device)s] %(name)s: %(message)s"
