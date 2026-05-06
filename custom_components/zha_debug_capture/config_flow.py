"""Config flow for ZHA Debug Capture.

Single-entry, one-click flow (no parameters). The integration exposes a
single boolean option ``show_in_sidebar`` via the Options Flow, which
toggles the registration of the sidebar panel. Changing it requires an
HA restart (or reloading the integration entry) to take effect.
"""
from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback

from .const import (
    DEFAULT_SHOW_IN_SIDEBAR,
    DOMAIN,
    OPTION_SHOW_IN_SIDEBAR,
)


class ZhaDebugCaptureConfigFlow(ConfigFlow, domain=DOMAIN):
    """Singleton config flow: one click, no inputs."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        return self.async_create_entry(title="ZHA Debug Capture", data={})

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: ConfigEntry,
    ) -> OptionsFlow:
        return ZhaDebugCaptureOptionsFlow(config_entry)


class ZhaDebugCaptureOptionsFlow(OptionsFlow):
    """Options flow exposing show_in_sidebar."""

    def __init__(self, config_entry: ConfigEntry) -> None:
        self.config_entry = config_entry

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        current = self.config_entry.options.get(
            OPTION_SHOW_IN_SIDEBAR, DEFAULT_SHOW_IN_SIDEBAR
        )
        schema = vol.Schema(
            {
                vol.Required(
                    OPTION_SHOW_IN_SIDEBAR, default=current
                ): bool,
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema)
