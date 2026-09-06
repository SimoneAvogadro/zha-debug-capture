# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Home Assistant custom integration (HACS-installable) that captures Zigbee
debug logs for a *selected subset* of ZHA devices, buffers them in RAM, and
flushes lazily to disk. The motivation is SD-card wear on Raspberry Pi
deployments — running `zigpy: debug` continuously is too noisy. See
`README.md` for the user-facing story.

There is no linter config and no package manager. The only unit tests are
`tests/test_log_gate.py` (stdlib `unittest`, no HA needed — run
`python3 -m unittest discover -s tests`); they cover `log_gate.py`, which is
kept stdlib-only for that reason. Everything else runs inside Home
Assistant; the JS frontend is hand-written ES2020+ with no bundler.

## Build / deploy

The only build step is concatenating the frontend panel:

```bash
./build.sh
```

This concatenates `src/header.js` + `src/panel.js` into
`custom_components/zha_debug_capture/www/panel.js`. **Always run this after
editing anything in `src/`** — Home Assistant serves the file from `www/`,
not from `src/`. The `www/panel.js` is checked in.

To test changes against a running HA: copy
`custom_components/zha_debug_capture/` into the HA `config/custom_components/`
directory and restart HA (or reload the integration entry from
Settings → Devices & Services).

Beyond the `log_gate` unit tests, verification means installing into HA and
exercising the panel + the services manually.

## Architecture

### Logger interception (the core trick)

`capture.py` does **not** subscribe to ZHA events. Instead, on `start_capture`:

1. Resolves HA `device_id`s to ZHA device proxies via
   `homeassistant.components.zha.helpers.async_get_zha_device_proxy`.
2. Builds a set of "needles" per device — IEEE (with and without colons) and
   NWK in `0xABCD` form — because different zigpy/bellows loggers print
   addresses in different formats.
3. Attaches a `MemoryBufferHandler`, carrying an `IeeeFilter` (substring
   match on the formatted message), to every logger in `CAPTURE_LOGGERS`
   (`const.py`). The filter lives on the *handler*, not the logger: Python
   only runs a logger's own filters for records that originate there, so a
   logger-level filter would let records propagated up from child loggers
   through unchecked.
4. Bumps each touched logger to `DEBUG` via `log_gate.raise_loggers_to_debug`,
   remembering both its own level (to restore on stop) and its *effective*
   level (see next step). Loggers whose `setLevel` is a no-op — HA's
   `logger` integration installs a `Logger` subclass that ignores
   `setLevel` for names the user overrode in `logger:` — are reported as
   `blocked_loggers` in the session/status and in the notification.
5. Installs a `LevelGateFilter` on HA's root handlers for the session's
   lifetime. Propagation never checks ancestor logger levels and HA's root
   `HomeAssistantQueueHandler` has no level of its own, so without this
   every DEBUG record we unlock would also land in `home-assistant.log`.
   The gate drops records from the raised loggers (and children) below
   their pre-session effective level, nothing else. `HomeAssistantQueueHandler.handle()`
   runs handler filters explicitly, so this is a supported hook. Removed on
   stop *after* the levels are restored.

`MemoryBufferHandler` accumulates lines in a `list[str]` guarded by a
`threading.Lock` (logging callsites can be on any thread). Flush to disk
happens only on:

- the periodic `async_call_later` timer (`flush_interval_minutes`, default 240)
- `stop_capture` (manual / auto-expire / entry unload / `EVENT_HOMEASSISTANT_STOP`)
- safety cap `DEFAULT_BUFFER_MAX_BYTES` (50 MB) — flushed synchronously from
  the logging thread to avoid OOM

Disk I/O always goes through `hass.async_add_executor_job(handler.flush_to_disk)`
to keep the event loop unblocked.

### Session state and concurrency

Only **one session** is active at a time. State lives in
`hass.data[DOMAIN]["session"]` as a `ZhaCaptureSession` dataclass. An
`asyncio.Lock` (`hass.data[DOMAIN]["lock"]`) serialises start/stop. To start
a new session while one is running, callers must pass `replace_existing=True`.

The periodic flush callback also re-resolves the device proxies and refreshes
the filter needles — this matters because **NWK can change after a device
rejoin**. IEEE never changes, so coverage is still robust between rejoin and
the next flush.

### Files written

Captures land in `<HA config>/zha_debug_capture/captures/zha_<YYYYMMDD_HHMMSS>.log`.
Two static paths are registered:
- `/zha_debug_capture/` → `custom_components/zha_debug_capture/www/` (panel JS)
- `/zha_debug_capture/captures/` → captures dir (download links)

`async_register_static_paths` is called once. On entry reload it can raise
`RuntimeError` ("already registered") which is swallowed. Static paths are
**not** unregistered on `async_unload_entry` — HA has no clean API for it
and leaving them is harmless.

### Frontend panel

Registered as a `custom` panel (`frontend.async_register_built_in_panel` with
`require_admin=True`). The panel element is a plain `HTMLElement` with Shadow
DOM — no LitElement, no build chain, no transpilation. It receives `hass` via
the standard HA panel-custom property.

The panel calls services via `hass.callService` and `hass.callWS`, listens to
the `zha_debug_capture_session_changed` event for live updates, and uses the
`/zha_debug_capture/captures/<filename>` static path for download links. i18n
is two flat dicts (`it`, `en`) selected from `localStorage.selectedLanguage`
or `navigator.language`, defaulting to Italian.

### Options flow

A single boolean option, `show_in_sidebar`, gated through an Options Flow.
`_async_options_updated` re-registers (or removes) the panel when toggled —
the README says a restart is needed, but the listener actually applies the
change live on entry reload.

## Conventions worth noting

- All user-visible notification text is in **Italian** (`_update_notification`
  in `capture.py`). The panel itself is bilingual (`it` / `en`). New
  user-facing strings should follow this split.
- `CAPTURE_LOGGERS` in `const.py` is the single source of truth for which
  loggers get hooked. Add new coordinator stacks there.
- Defensive `try/except Exception` around teardown steps in
  `_stop_capture_locked` is intentional — stop must never fail partially and
  leave handlers attached.
- Version lives in three places that must stay in sync: `const.py:VERSION`,
  `manifest.json:version`, and the `?v=` cache-buster on the panel module URL
  (which reads `VERSION`, so just bump the two declarations).
