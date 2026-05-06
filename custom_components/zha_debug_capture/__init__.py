"""ZHA Debug Capture custom integration.

Registers a sidebar panel and a set of services that allow capturing
Zigbee traffic in/out of selected ZHA devices, with the records filtered
at the Python logger level and buffered in RAM until a periodic / manual
flush. The goal is to drastically reduce SD-card wear compared to running
``zigpy: debug`` continuously.

Services:
    - zha_debug_capture.start
    - zha_debug_capture.stop
    - zha_debug_capture.status        (response_only)
    - zha_debug_capture.list_captures (response_only)
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.components import frontend
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STOP
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.helpers import config_validation as cv

from .capture import (
    list_capture_files,
    session_status,
    start_capture,
    stop_capture,
)
from .const import (
    ATTR_DEVICES,
    ATTR_END_TIME,
    ATTR_FLUSH_INTERVAL_MINUTES,
    ATTR_REPLACE_EXISTING,
    CAPTURE_DIR_NAME,
    DEFAULT_FLUSH_INTERVAL_MINUTES,
    DEFAULT_SHOW_IN_SIDEBAR,
    DOMAIN,
    OPTION_SHOW_IN_SIDEBAR,
    PANEL_ELEMENT_NAME,
    PANEL_URL_PATH,
    SERVICE_LIST_CAPTURES,
    SERVICE_START,
    SERVICE_STATUS,
    SERVICE_STOP,
    URL_BASE,
    VERSION,
)

_LOGGER = logging.getLogger(__name__)

CAPTURES_URL = f"{URL_BASE}/captures"

START_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_DEVICES): vol.All(cv.ensure_list, [cv.string]),
        vol.Required(ATTR_END_TIME): cv.datetime,
        vol.Optional(
            ATTR_FLUSH_INTERVAL_MINUTES,
            default=DEFAULT_FLUSH_INTERVAL_MINUTES,
        ): vol.All(vol.Coerce(int), vol.Range(min=1, max=1440)),
        vol.Optional(ATTR_REPLACE_EXISTING, default=False): cv.boolean,
    }
)

EMPTY_SCHEMA = vol.Schema({})


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up the integration from a config entry."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    domain_data.setdefault("session", None)
    # Lock is created lazily by start/stop_capture; setdefault here to avoid
    # races if the entry is reloaded quickly.
    import asyncio

    domain_data.setdefault("lock", asyncio.Lock())

    # Make sure the captures directory exists so the static path can serve it
    # (HA tolerates a missing dir but creating it now keeps things explicit).
    captures_dir = Path(hass.config.path(DOMAIN)) / CAPTURE_DIR_NAME
    captures_dir.mkdir(parents=True, exist_ok=True)

    await _async_register_static_paths(hass, captures_dir)
    _async_register_panel_if_enabled(hass, entry)
    _async_register_services(hass)

    async def _async_stop(_event: Any) -> None:
        """On HA shutdown, flush and close the active capture, if any."""
        try:
            await stop_capture(hass, reason="ha_shutdown")
        except Exception as err:  # pragma: no cover - defensive
            _LOGGER.error("Error during shutdown stop: %s", err)

    entry.async_on_unload(
        hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, _async_stop)
    )
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))

    _LOGGER.info("ZHA Debug Capture v%s loaded", VERSION)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Stop active session, remove panel + services, drop runtime state."""
    try:
        await stop_capture(hass, reason="entry_unload")
    except Exception as err:  # pragma: no cover - defensive
        _LOGGER.error("Error stopping capture during unload: %s", err)

    try:
        frontend.async_remove_panel(hass, PANEL_URL_PATH)
    except Exception:
        # Panel may not have been registered (e.g. show_in_sidebar=False).
        pass

    for svc in (SERVICE_START, SERVICE_STOP, SERVICE_STATUS, SERVICE_LIST_CAPTURES):
        hass.services.async_remove(DOMAIN, svc)

    hass.data.pop(DOMAIN, None)
    # Static paths cannot be unregistered cleanly; leaving them is harmless.
    return True


async def _async_options_updated(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Re-register or remove the sidebar panel when options change."""
    show = entry.options.get(OPTION_SHOW_IN_SIDEBAR, DEFAULT_SHOW_IN_SIDEBAR)
    try:
        frontend.async_remove_panel(hass, PANEL_URL_PATH)
    except Exception:
        pass
    if show:
        _async_register_panel(hass)


async def _async_register_static_paths(
    hass: HomeAssistant, captures_dir: Path
) -> None:
    www_dir = Path(__file__).parent / "www"
    paths = [
        StaticPathConfig(URL_BASE, str(www_dir), False),
        StaticPathConfig(CAPTURES_URL, str(captures_dir), False),
    ]
    try:
        await hass.http.async_register_static_paths(paths)
    except RuntimeError:
        # Already registered (entry reload).
        _LOGGER.debug(
            "Static paths %s / %s already registered", URL_BASE, CAPTURES_URL
        )


def _async_register_panel_if_enabled(
    hass: HomeAssistant, entry: ConfigEntry
) -> None:
    if entry.options.get(OPTION_SHOW_IN_SIDEBAR, DEFAULT_SHOW_IN_SIDEBAR):
        _async_register_panel(hass)


def _async_register_panel(hass: HomeAssistant) -> None:
    try:
        frontend.async_register_built_in_panel(
            hass,
            component_name="custom",
            sidebar_title="ZHA Debug",
            sidebar_icon="mdi:bug-outline",
            frontend_url_path=PANEL_URL_PATH,
            config={
                "_panel_custom": {
                    "name": PANEL_ELEMENT_NAME,
                    "module_url": f"{URL_BASE}/panel.js?v={VERSION}",
                    "embed_iframe": False,
                    "trust_external": False,
                }
            },
            require_admin=True,
        )
    except ValueError:
        # Panel already registered.
        _LOGGER.debug("Panel %s already registered", PANEL_URL_PATH)


def _async_register_services(hass: HomeAssistant) -> None:
    async def _handle_start(call: ServiceCall) -> None:
        try:
            await start_capture(
                hass,
                device_ids=list(call.data[ATTR_DEVICES]),
                end_time=call.data[ATTR_END_TIME],
                flush_interval_minutes=int(
                    call.data.get(
                        ATTR_FLUSH_INTERVAL_MINUTES,
                        DEFAULT_FLUSH_INTERVAL_MINUTES,
                    )
                ),
                replace_existing=bool(
                    call.data.get(ATTR_REPLACE_EXISTING, False)
                ),
            )
        except (RuntimeError, ValueError) as err:
            from homeassistant.exceptions import HomeAssistantError

            raise HomeAssistantError(str(err)) from err

    async def _handle_stop(_call: ServiceCall) -> None:
        await stop_capture(hass, reason="manual")

    async def _handle_status(_call: ServiceCall) -> dict[str, Any]:
        return session_status(hass)

    async def _handle_list_captures(_call: ServiceCall) -> dict[str, Any]:
        return {"files": list_capture_files(hass)}

    hass.services.async_register(
        DOMAIN, SERVICE_START, _handle_start, schema=START_SCHEMA
    )
    hass.services.async_register(
        DOMAIN, SERVICE_STOP, _handle_stop, schema=EMPTY_SCHEMA
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_STATUS,
        _handle_status,
        schema=EMPTY_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_LIST_CAPTURES,
        _handle_list_captures,
        schema=EMPTY_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )
