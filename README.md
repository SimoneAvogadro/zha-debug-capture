# ZHA Debug Capture

Custom Home Assistant integration that captures **only** the Zigbee traffic of a
hand-picked subset of ZHA devices, with the in/out frames buffered in RAM and
written to disk only on a slow schedule (default every 4h) or on shutdown.

Designed to give you targeted, low-noise insight into a single device's
behaviour — without the SD-card wear of running `zigpy: debug` continuously.

> Why this exists: when a flaky ZHA device misbehaves, the standard advice is
> to enable `zigpy: debug` and grep `home-assistant.log`. But on a Raspberry Pi
> with an SD card you're trading lifespan for diagnostics, and HA's logger
> filtering only excludes by regex, never includes by device. This tool fills
> that gap with a Python `logging.Filter` installed at runtime on the relevant
> loggers, plus a custom in-memory handler that flushes lazily.

## What you get

- **Sidebar panel** — `ZHA Debug` shows up in HA's left menu (admin-only).
  Lists every ZHA device with checkbox selection, a search filter, and a
  time-of-day picker for when the capture should auto-stop.
- **`home-assistant.log` stays clean** — during a session the ZHA loggers
  run at DEBUG, but a gate filter on HA's root log handler drops those
  DEBUG records from the main log; only the capture file receives them,
  and only for the selected devices. Warnings and errors flow as usual.
- **In-memory buffer** — flushed every 4h by default (configurable per
  session). Final flush on stop, on shutdown, or when the buffer reaches
  50 MB.
- **Multiple coordinator support** — `bellows` (ZBDongle-E / SkyConnect),
  `zigpy_znp` (CC2652), `zigpy_deconz` (ConBee), `zigpy_xbee`.
- **Services** — usable from automations / Dev Tools too:
  - `zha_debug_capture.start`
  - `zha_debug_capture.stop`
  - `zha_debug_capture.status` (returns active session details)
  - `zha_debug_capture.list_captures` (returns saved files)

## Install via HACS

1. HACS → ⋮ → Custom repositories → add this repo URL, category Integration.
2. Search "ZHA Debug Capture" → Install → restart Home Assistant.
3. Settings → Devices & Services → Add Integration → "ZHA Debug Capture"
   (one-click, no inputs).
4. The `ZHA Debug` entry appears in your sidebar.

## Manual install

Copy `custom_components/zha_debug_capture/` to your `/config/custom_components/`
folder, then restart HA.

## Use it

1. Click `ZHA Debug` in the sidebar.
2. Tick the devices you want to log.
3. Pick the end time (defaults to now + 30 min, rounded up to 5 min).
4. Optional: change the flush interval. Default 240 min keeps SD-card writes
   minimal. Lower it (e.g. 5 min) if you want fresher data on disk while a
   capture is ongoing.
5. **Avvia cattura** — a session badge appears with the live buffer size.
6. Reproduce the device misbehaviour.
7. Either click **Stop** or wait for the auto-stop. The log file is written to
   `/config/zha_debug_capture/captures/zha_<YYYYMMDD_HHMMSS>.log` and shown in
   the **Capture salvate** list with a download link.

## Use the services directly (e.g. from automations)

```yaml
service: zha_debug_capture.start
data:
  devices:
    - 84a3f3e5e0e6b1d4ce5aaa  # device_id of the QT06 valve
  end_time: "2026-05-06T14:32:00"
  flush_interval_minutes: 5
  replace_existing: true
```

```yaml
service: zha_debug_capture.status
response_variable: capture_status
```

## Reading the log

The format is identical to `home-assistant.log`:

```
2026-05-06 14:30:12.345 DEBUG zigpy.zcl: [0x1A2B:1:0x0006] Sending request: ...
2026-05-06 14:30:12.380 DEBUG bellows.zigbee.application: Got Default_Response: status=SUCCESS
```

Useful filters once you have the file:

```bash
# every command sent to your QT06 (cluster 0x0006 = on/off, 0xef00 = Tuya)
grep -iE "0x0006|0xef00" zha_20260506_143012.log

# only success/failure responses
grep -iE "Default_Response" zha_20260506_143012.log
```

## SD-card friendliness

A device chatty enough to send a sensor report every 10 s produces ~250 B per
log record. Across 5 such devices over 4 h that is roughly **1.8 MB of buffer
per flush** — one sequential write every 4 h, versus the continuous
multi-MB/hour stream that `zigpy: debug` would dump into `home-assistant.log`.
On a Pi with SD storage that's roughly a 1000× reduction in writes.

A power cut during a session loses the unflushed buffer (acceptable trade-off).
The session is **not** restored across HA restarts — start a fresh one if you
need to.

## Hide the sidebar entry

Settings → Devices & Services → ZHA Debug Capture → Configure → toggle
**Show in sidebar** off. Restart HA (or reload the integration entry) for the
change to apply.

## Caveats

- The capture is filtered by IEEE / NWK substring on the formatted log
  message. NWK can change after a device rejoin; we re-resolve it at every
  flush, but a record emitted between the rejoin and the next flush could be
  missed. IEEE is always matched, which keeps coverage robust.
- Only one session can be active at a time. Set `replace_existing: true` on
  start to terminate a running session and immediately begin a new one.
- The integration needs admin rights to register the panel; the panel is
  visible only to admins.

## License

MIT — see [LICENSE](LICENSE).
