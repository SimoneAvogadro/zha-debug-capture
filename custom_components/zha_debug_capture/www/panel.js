// zha-debug-capture — sidebar panel bundle
// Repo: https://github.com/SimoneAvogadro/zha-debug-capture
// Pure HTMLElement + Shadow DOM, no LitElement, no build chain.

"use strict";

const DOMAIN = "zha_debug_capture";
const EVENT_SESSION_CHANGED = "zha_debug_capture_session_changed";

const I18N = {
  it: {
    title: "ZHA Debug Capture",
    refresh: "Aggiorna",
    menu: "Apri menù",
    sessionHeading: "Sessione",
    sessionActive: "● attiva",
    sessionInactive: "○ nessuna sessione attiva",
    sessionExpiresAt: "Scade alle",
    sessionStartedAt: "Iniziata alle",
    sessionDevices: "Device",
    sessionBuffer: "Buffer",
    sessionFile: "File",
    sessionStop: "Stop sessione",
    devicesHeading: "Device ZHA",
    deviceFilterPlaceholder: "Filtra per nome / area / IEEE…",
    deviceSelected: "Selezionati",
    deviceLoading: "Caricamento device ZHA…",
    deviceNoZha: "Nessun device ZHA trovato. Verifica che l'integrazione ZHA sia attiva.",
    formHeading: "Avvia nuova cattura",
    formEndTime: "Fine cattura",
    formFlushInterval: "Flush ogni (minuti)",
    formReplaceExisting: "Sostituisci sessione attiva",
    formStart: "Avvia cattura",
    capturesHeading: "Capture salvate",
    capturesEmpty: "Nessun file salvato.",
    capturesDownload: "Scarica",
    captureDelete: "Elimina file",
    confirmDelete: "Eliminare definitivamente {file}?",
    tailHeading: "Live tail",
    tailEmpty: "In attesa del primo messaggio dei device selezionati…",
    tailPaused: "(in pausa: scheda non in primo piano)",
    errorNoDevices: "Seleziona almeno un device.",
    errorNoEndTime: "Imposta un orario di fine valido nel futuro.",
    errorEndTimeTooFar: "La fine cattura non può essere oltre 7 giorni da adesso.",
    errorDownload: "Download non riuscito: {error}",
    confirmStop: "Fermare la sessione di cattura attiva?",
  },
  en: {
    title: "ZHA Debug Capture",
    refresh: "Refresh",
    menu: "Open menu",
    sessionHeading: "Session",
    sessionActive: "● active",
    sessionInactive: "○ no active session",
    sessionExpiresAt: "Expires at",
    sessionStartedAt: "Started at",
    sessionDevices: "Devices",
    sessionBuffer: "Buffer",
    sessionFile: "File",
    sessionStop: "Stop session",
    devicesHeading: "ZHA devices",
    deviceFilterPlaceholder: "Filter by name / area / IEEE…",
    deviceSelected: "Selected",
    deviceLoading: "Loading ZHA devices…",
    deviceNoZha: "No ZHA devices found. Make sure the ZHA integration is set up.",
    formHeading: "Start new capture",
    formEndTime: "Capture end",
    formFlushInterval: "Flush every (min)",
    formReplaceExisting: "Replace active session",
    formStart: "Start capture",
    capturesHeading: "Saved captures",
    capturesEmpty: "No files saved.",
    capturesDownload: "Download",
    captureDelete: "Delete file",
    confirmDelete: "Permanently delete {file}?",
    tailHeading: "Live tail",
    tailEmpty: "Waiting for the first message from the selected devices…",
    tailPaused: "(paused: tab not in foreground)",
    errorNoDevices: "Select at least one device.",
    errorNoEndTime: "Set a valid end time in the future.",
    errorEndTimeTooFar: "Capture end can't be more than 7 days from now.",
    errorDownload: "Download failed: {error}",
    confirmStop: "Stop the active capture session?",
  },
};

function pickLang() {
  const stored = (localStorage.getItem("selectedLanguage") || "").toLowerCase();
  if (stored && I18N[stored]) return stored;
  const nav = (navigator.language || "en").slice(0, 2).toLowerCase();
  return I18N[nav] ? nav : "it";
}

function fmtTime(date) {
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function ceilToFiveMinutes(date) {
  const d = new Date(date.getTime());
  const m = d.getMinutes();
  const next = Math.ceil(m / 5) * 5;
  if (next === 60) {
    d.setHours(d.getHours() + 1);
    d.setMinutes(0);
  } else {
    d.setMinutes(next);
  }
  d.setSeconds(0);
  d.setMilliseconds(0);
  return d;
}

function defaultEndTime() {
  const now = new Date();
  now.setMinutes(now.getMinutes() + 30);
  return ceilToFiveMinutes(now);
}

function parseDateTimeInput(value) {
  // value: "YYYY-MM-DDTHH:MM" from <input type="datetime-local"> (local time).
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The Home Assistant Android companion app hands plain http(s) download links
// to the system DownloadManager, which runs outside the app and therefore has
// neither the WebView session nor its TLS client certificate. On instances that
// require mTLS (or use a private CA) every such download fails with a bare
// "download failed" notification. Fetching the file inside the WebView and
// handing the app a blob: URL instead keeps the whole transfer on the
// connection that is already authenticated.
function isAndroidCompanion() {
  return !!(window.externalApp || window.externalAppV2);
}

// The companion app reads the blob asynchronously after the click, so the URL
// must stay alive for a while — same delay the HA frontend uses.
const BLOB_REVOKE_DELAY_MS = 10000;

function triggerBlobDownload(blob, filename) {
  const href = URL.createObjectURL(blob);
  const el = document.createElement("a");
  el.href = href;
  el.download = filename;
  el.style.display = "none";
  document.body.appendChild(el);
  el.dispatchEvent(new MouseEvent("click"));
  document.body.removeChild(el);
  setTimeout(() => URL.revokeObjectURL(href), BLOB_REVOKE_DELAY_MS);
}

function dateTimeInputValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const da = pad(date.getDate());
  const h = pad(date.getHours());
  const m = pad(date.getMinutes());
  return `${y}-${mo}-${da}T${h}:${m}`;
}

class ZhaDebugCapturePanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._narrow = false;
    this._lang = pickLang();
    this._t = I18N[this._lang];
    this._devices = null;
    this._areaMap = {};
    this._loadError = null;
    this._session = { active: false };
    this._captures = [];
    this._selected = new Set();
    this._filter = "";
    this._endTime = defaultEndTime();
    this._flushMinutes = 240;
    this._replaceExisting = false;
    this._eventUnsub = null;
    this._initialized = false;
    this._busy = false;
    this._error = "";
    this._statusTimer = null;
    this._tail = { lines: [] };
    this._tailTimer = null;
    this._tailFetching = false;
    this._tailVisibilityHandler = null;
    this._tailPaused = false;
  }

  set hass(value) {
    this._hass = value;
    if (!this._initialized) {
      this._initialized = true;
      this._initialize();
    }
  }

  set narrow(value) {
    this._narrow = !!value;
    this._render();
  }

  set route(value) {
    // unused; single-page panel
  }

  set panel(value) {
    // unused
  }

  connectedCallback() {
    this._render();
  }

  disconnectedCallback() {
    if (this._eventUnsub) {
      try { this._eventUnsub(); } catch (e) { /* ignore */ }
      this._eventUnsub = null;
    }
    if (this._statusTimer) {
      clearInterval(this._statusTimer);
      this._statusTimer = null;
    }
    this._stopTailLoop();
  }

  async _initialize() {
    await this._loadDevices();
    await this._refreshSession();
    await this._refreshCaptures();
    this._subscribeEvents();
    this._startStatusTicker();
    this._render();
    this._syncTailLoop();
  }

  async _loadDevices() {
    if (!this._hass) return;
    try {
      const [devices, entries, areas] = await Promise.all([
        this._hass.callWS({ type: "config/device_registry/list" }),
        this._hass.callWS({ type: "config_entries/get" }),
        this._hass.callWS({ type: "config/area_registry/list" }),
      ]);
      const zhaEntryIds = new Set(
        (entries || [])
          .filter((e) => e && e.domain === "zha")
          .map((e) => e.entry_id),
      );
      this._areaMap = Object.fromEntries(
        (areas || []).map((a) => [a.area_id, a.name]),
      );
      const zhaDevices = (devices || [])
        .filter((d) =>
          Array.isArray(d.config_entries)
          && d.config_entries.some((eid) => zhaEntryIds.has(eid)),
        )
        .map((d) => {
          const ieee = (d.identifiers || [])
            .filter((id) => Array.isArray(id) && id[0] === "zha")
            .map((id) => id[1])
            .find(Boolean) || "";
          return {
            id: d.id,
            name: d.name_by_user || d.name || ieee || "(unnamed)",
            area: d.area_id ? (this._areaMap[d.area_id] || "") : "",
            model: d.model || "",
            manufacturer: d.manufacturer || "",
            ieee,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      this._devices = zhaDevices;
      this._loadError = null;
    } catch (err) {
      this._loadError = String(err && err.message ? err.message : err);
      this._devices = [];
    }
  }

  async _refreshSession() {
    if (!this._hass) return;
    try {
      const resp = await this._hass.callService(
        DOMAIN, "status", {}, undefined, false, true,
      );
      // hass.callService returns { context, response } when returnResponse=true.
      const data = resp && resp.response ? resp.response : resp;
      this._session = data || { active: false };
    } catch (err) {
      this._session = { active: false };
    }
  }

  async _refreshCaptures() {
    if (!this._hass) return;
    try {
      const resp = await this._hass.callService(
        DOMAIN, "list_captures", {}, undefined, false, true,
      );
      const data = resp && resp.response ? resp.response : resp;
      this._captures = (data && data.files) || [];
    } catch (err) {
      this._captures = [];
    }
  }

  _subscribeEvents() {
    if (!this._hass || !this._hass.connection) return;
    try {
      const p = this._hass.connection.subscribeEvents(
        () => this._onSessionEvent(),
        EVENT_SESSION_CHANGED,
      );
      Promise.resolve(p).then((unsub) => {
        this._eventUnsub = unsub;
      }).catch(() => {});
    } catch (e) {
      // older HA versions
    }
  }

  async _onSessionEvent() {
    await this._refreshSession();
    await this._refreshCaptures();
    this._render();
    this._syncTailLoop();
  }

  _startStatusTicker() {
    // Re-render every 30s to keep the "in N min" countdown fresh.
    if (this._statusTimer) clearInterval(this._statusTimer);
    this._statusTimer = setInterval(() => {
      if (this._session && this._session.active) this._render();
    }, 30000);
  }

  _syncTailLoop() {
    const isActive = this._session && this._session.active;
    if (isActive) this._startTailLoop();
    else this._stopTailLoop();
  }

  _startTailLoop() {
    if (this._tailVisibilityHandler) return; // already running
    this._tailVisibilityHandler = () => {
      if (document.visibilityState === "visible") {
        this._tailPaused = false;
        this._tickTail();
        if (!this._tailTimer) {
          this._tailTimer = setInterval(() => this._tickTail(), 4000);
        }
      } else if (this._tailTimer) {
        clearInterval(this._tailTimer);
        this._tailTimer = null;
        this._tailPaused = true;
        this._renderTailPausedHint();
      }
    };
    document.addEventListener("visibilitychange", this._tailVisibilityHandler);
    if (document.visibilityState === "visible") {
      this._tickTail();
      this._tailTimer = setInterval(() => this._tickTail(), 4000);
    } else {
      this._tailPaused = true;
    }
  }

  _stopTailLoop() {
    if (this._tailTimer) {
      clearInterval(this._tailTimer);
      this._tailTimer = null;
    }
    if (this._tailVisibilityHandler) {
      document.removeEventListener("visibilitychange", this._tailVisibilityHandler);
      this._tailVisibilityHandler = null;
    }
    this._tailPaused = false;
    this._tail = { lines: [] };
  }

  async _tickTail() {
    if (this._tailFetching || !this._hass) return;
    this._tailFetching = true;
    try {
      const resp = await this._hass.callService(
        DOMAIN, "tail", { lines: 200 }, undefined, false, true,
      );
      const data = resp && resp.response ? resp.response : resp;
      if (data && data.active) {
        this._tail = { lines: data.lines || [] };
        if (this._session) this._session.buffered_bytes = data.buffered_bytes;
        this._renderTailInPlace();
      } else {
        // Session ended underneath us — stop the loop, let the event handler
        // refresh the rest of the UI.
        this._stopTailLoop();
      }
    } catch (e) {
      // Transient errors: ignore, retry on the next tick.
    } finally {
      this._tailFetching = false;
    }
  }

  _renderTailInPlace() {
    const box = this.shadowRoot.querySelector(".tail-box");
    if (!box) return;
    const lines = this._tail.lines || [];
    if (lines.length === 0) {
      box.classList.add("empty");
      box.textContent = this._t.tailEmpty;
      return;
    }
    // Decide whether to auto-follow BEFORE swapping content. A 100px window
    // keeps follow active even after very fast streams, while still dropping
    // out if the user has clearly scrolled up to inspect older lines.
    const nearBottom =
      box.scrollHeight - box.scrollTop - box.clientHeight < 100;
    box.classList.remove("empty");
    box.textContent = lines.join("\n");
    if (nearBottom) {
      // Wait one frame so layout has applied — otherwise scrollHeight is the
      // stale pre-update value and we end up parked above the new tail.
      requestAnimationFrame(() => {
        box.scrollTop = box.scrollHeight;
      });
    }
    // Keep the buffer-size indicator in the session card fresh too.
    const bufEl = this.shadowRoot.querySelector(".session-buffer");
    if (bufEl && this._session) {
      bufEl.textContent = fmtBytes(this._session.buffered_bytes || 0);
    }
    this._renderTailPausedHint();
  }

  _renderTailPausedHint() {
    const hint = this.shadowRoot.querySelector(".tail-paused-hint");
    if (!hint) return;
    hint.textContent = this._tailPaused ? this._t.tailPaused : "";
  }

  async _onStartClick() {
    this._error = "";
    if (this._selected.size === 0) {
      this._error = this._t.errorNoDevices;
      this._render();
      return;
    }
    if (!this._endTime) {
      this._error = this._t.errorNoEndTime;
      this._render();
      return;
    }
    const now = new Date();
    const diffMs = this._endTime.getTime() - now.getTime();
    if (diffMs > 7 * 24 * 3600 * 1000) {
      this._error = this._t.errorEndTimeTooFar;
      this._render();
      return;
    }
    if (diffMs <= 0) {
      this._error = this._t.errorNoEndTime;
      this._render();
      return;
    }
    this._busy = true;
    this._render();
    try {
      await this._hass.callService(DOMAIN, "start", {
        devices: Array.from(this._selected),
        end_time: this._endTime.toISOString(),
        flush_interval_minutes: this._flushMinutes,
        replace_existing: this._replaceExisting,
      });
      // Event will trigger a refresh, but force one now too.
      await this._refreshSession();
    } catch (err) {
      this._error = String(err && err.message ? err.message : err);
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _onCaptureLinkClick(event, link) {
    // Outside the Android app the plain link works and streams straight to
    // disk, which is cheaper for large captures — leave it alone.
    if (!isAndroidCompanion()) return;
    event.preventDefault();
    const filename = link.getAttribute("data-filename");
    this._busy = true;
    this._error = "";
    this._render();
    try {
      const resp = await fetch(link.href);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      triggerBlobDownload(await resp.blob(), filename);
    } catch (err) {
      this._error = this._t.errorDownload.replace(
        "{error}",
        String(err && err.message ? err.message : err),
      );
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _onDeleteCapture(filename) {
    if (!filename) return;
    const msg = this._t.confirmDelete.replace("{file}", filename);
    if (!confirm(msg)) return;
    this._busy = true;
    this._error = "";
    this._render();
    try {
      await this._hass.callService(DOMAIN, "delete_capture", { filename });
      await this._refreshCaptures();
    } catch (err) {
      this._error = String(err && err.message ? err.message : err);
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _onStopClick() {
    if (!confirm(this._t.confirmStop)) return;
    this._busy = true;
    this._render();
    try {
      await this._hass.callService(DOMAIN, "stop", {});
      await this._refreshSession();
    } catch (err) {
      this._error = String(err && err.message ? err.message : err);
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _onRefreshClick() {
    await this._loadDevices();
    await this._refreshSession();
    await this._refreshCaptures();
    this._render();
  }

  _toggleMenu() {
    // Narrow viewports hide HA's sidebar; this event asks the root
    // <home-assistant> element to toggle it so the user isn't stuck.
    this.dispatchEvent(new CustomEvent("hass-toggle-menu", {
      bubbles: true,
      composed: true,
    }));
  }

  _onDeviceToggle(deviceId, checked) {
    if (checked) this._selected.add(deviceId);
    else this._selected.delete(deviceId);
    // Avoid full re-render: it would reset the device-list scroll position
    // mid-selection. The browser already handled the visual checkbox state;
    // we only need to refresh the counter.
    const counter = this.shadowRoot.querySelector(".selected-count");
    if (counter) {
      counter.textContent = `${this._t.deviceSelected}: ${this._selected.size}`;
    }
  }

  _onFilterInput(value) {
    this._filter = (value || "").toLowerCase();
    this._render();
  }

  _onTimeChange(value) {
    const parsed = parseDateTimeInput(value);
    if (parsed) this._endTime = parsed;
    // No re-render: rebuilding the form steals focus from the picker mid-edit.
  }

  _onFlushChange(value) {
    const n = parseInt(value, 10);
    if (Number.isFinite(n) && n >= 1) this._flushMinutes = n;
  }

  _onReplaceChange(checked) {
    this._replaceExisting = !!checked;
  }

  _filteredDevices() {
    if (!this._devices) return [];
    if (!this._filter) return this._devices;
    return this._devices.filter((d) => {
      const haystack = [d.name, d.area, d.model, d.manufacturer, d.ieee]
        .join(" ").toLowerCase();
      return haystack.includes(this._filter);
    });
  }

  _renderSession() {
    const t = this._t;
    if (!this._session || !this._session.active) {
      return `
        <div class="session inactive">
          <div class="status">${t.sessionInactive}</div>
        </div>
      `;
    }
    const expires = new Date(this._session.expires_at);
    const started = new Date(this._session.started_at);
    const minutesLeft = Math.max(0, Math.round(
      (expires.getTime() - Date.now()) / 60000,
    ));
    const filename = (this._session.file_path || "").split("/").pop();
    const devices = (this._session.device_names || []).join(", ")
      || (this._session.device_ieees || []).join(", ");
    return `
      <div class="session active">
        <div class="status">${t.sessionActive} — ${t.sessionExpiresAt} ${fmtTime(expires)} (${minutesLeft} min)</div>
        <div class="meta"><span class="label">${t.sessionStartedAt}</span> ${fmtTime(started)}</div>
        <div class="meta"><span class="label">${t.sessionDevices}</span> ${devices || "?"}</div>
        <div class="meta"><span class="label">${t.sessionBuffer}</span> <span class="session-buffer">${fmtBytes(this._session.buffered_bytes || 0)}</span></div>
        <div class="meta"><span class="label">${t.sessionFile}</span> <code>${filename || "?"}</code></div>
        <div class="actions">
          <button id="stop-btn" ${this._busy ? "disabled" : ""}>${t.sessionStop}</button>
        </div>
      </div>
    `;
  }

  _renderDeviceList() {
    const t = this._t;
    if (this._loadError) {
      return `<div class="loading error">${this._loadError}</div>`;
    }
    if (this._devices === null) {
      return `<div class="loading">${t.deviceLoading}</div>`;
    }
    if (this._devices.length === 0) {
      return `<div class="loading">${t.deviceNoZha}</div>`;
    }
    const filtered = this._filteredDevices();
    return filtered.map((d) => {
      const checked = this._selected.has(d.id) ? "checked" : "";
      const sub = [d.area, d.model, d.ieee].filter(Boolean).join(" · ");
      return `
        <label class="device">
          <input type="checkbox" data-device-id="${d.id}" ${checked} />
          <span class="device-text">
            <span class="device-name">${d.name}</span>
            <span class="device-sub">${sub}</span>
          </span>
        </label>
      `;
    }).join("");
  }

  _renderTail() {
    const t = this._t;
    const lines = (this._tail && this._tail.lines) || [];
    const isEmpty = lines.length === 0;
    const content = isEmpty
      ? escapeHtml(t.tailEmpty)
      : escapeHtml(lines.join("\n"));
    const cls = isEmpty ? "tail-box empty" : "tail-box";
    const hint = this._tailPaused ? escapeHtml(t.tailPaused) : "";
    return `
      <div class="tail-card">
        <h2>${t.tailHeading} <span class="tail-paused-hint">${hint}</span></h2>
        <pre class="${cls}">${content}</pre>
      </div>
    `;
  }

  _renderCaptures() {
    const t = this._t;
    if (this._captures.length === 0) {
      return `<div class="empty">${t.capturesEmpty}</div>`;
    }
    return this._captures.map((c) => {
      const url = `/${DOMAIN}/captures/${encodeURIComponent(c.filename)}`;
      const when = new Date(c.modified).toLocaleString();
      const safeName = escapeHtml(c.filename);
      return `
        <div class="capture">
          <a
            href="${url}"
            download
            class="capture-link"
            data-filename="${safeName}"
          >
            <code>${safeName}</code>
          </a>
          <span class="capture-right">
            <span class="capture-meta">${fmtBytes(c.size_bytes)} · ${when}</span>
            <button
              class="capture-delete"
              data-filename="${safeName}"
              title="${escapeHtml(t.captureDelete)}"
              aria-label="${escapeHtml(t.captureDelete)}"
            >✕</button>
          </span>
        </div>
      `;
    }).join("");
  }

  _render() {
    const t = this._t;
    const isActive = this._session && this._session.active;
    // Preserve the device-list scroll position across renders triggered by
    // session/status updates, filter changes, etc.
    const prevScroll = this.shadowRoot.querySelector(".device-list")?.scrollTop ?? 0;
    const errorBanner = this._error
      ? `<div class="error-banner">${this._error}</div>`
      : "";

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          background: var(--primary-background-color);
          color: var(--primary-text-color);
          min-height: 100vh;
          font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
        }
        .header {
          position: sticky;
          top: 0;
          background: var(--app-header-background-color, var(--primary-color));
          color: var(--app-header-text-color, var(--text-primary-color));
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 20px;
          z-index: 5;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .header-left {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .icon-btn {
          background: transparent;
          color: inherit;
          border: none;
          padding: 4px;
          margin: -4px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          border-radius: 50%;
        }
        .icon-btn:hover {
          background: rgba(255,255,255,0.12);
        }
        .header h1 {
          margin: 0;
          font-size: 18px;
          font-weight: 500;
        }
        .header button {
          background: transparent;
          color: inherit;
          border: 1px solid currentColor;
          border-radius: 4px;
          padding: 6px 12px;
          cursor: pointer;
          font-size: 13px;
        }
        .body {
          padding: 16px;
          max-width: 1200px;
          margin: 0 auto;
        }
        .grid {
          display: grid;
          grid-template-columns: ${this._narrow ? "1fr" : "minmax(280px, 380px) 1fr"};
          gap: 16px;
        }
        .col {
          background: var(--card-background-color, white);
          border-radius: 8px;
          padding: 16px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.06);
        }
        h2 {
          font-size: 15px;
          font-weight: 500;
          margin: 0 0 12px;
          color: var(--secondary-text-color);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .session.inactive .status {
          color: var(--secondary-text-color);
        }
        .session.active .status {
          color: var(--success-color, #4caf50);
          font-weight: 500;
        }
        .session .meta {
          margin-top: 6px;
          font-size: 13px;
        }
        .session .meta .label {
          color: var(--secondary-text-color);
          display: inline-block;
          min-width: 80px;
        }
        .session .actions {
          margin-top: 12px;
        }
        .form {
          margin-top: 16px;
          padding-top: 16px;
          border-top: 1px solid var(--divider-color, #e0e0e0);
        }
        .form .row {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 12px;
          flex-wrap: wrap;
        }
        .form label {
          font-size: 13px;
          color: var(--secondary-text-color);
          min-width: 120px;
        }
        .form input[type="time"],
        .form input[type="datetime-local"],
        .form input[type="number"] {
          background: var(--secondary-background-color, #f4f4f4);
          color: var(--primary-text-color);
          border: 1px solid var(--divider-color, #ccc);
          border-radius: 4px;
          padding: 6px 8px;
          font-size: 14px;
          font-family: inherit;
        }
        .form .help {
          color: var(--secondary-text-color);
          font-size: 12px;
        }
        .filter-input {
          width: 100%;
          background: var(--secondary-background-color, #f4f4f4);
          color: var(--primary-text-color);
          border: 1px solid var(--divider-color, #ccc);
          border-radius: 4px;
          padding: 8px 10px;
          font-size: 14px;
          margin-bottom: 8px;
          box-sizing: border-box;
        }
        .device-list {
          max-height: calc(100vh - 220px);
          min-height: 240px;
          overflow-y: auto;
          margin: 0 -8px;
        }
        .device {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          padding: 8px;
          border-radius: 4px;
          cursor: pointer;
        }
        .device:hover {
          background: var(--secondary-background-color, #f4f4f4);
        }
        .device input[type="checkbox"] {
          margin-top: 2px;
        }
        .device-text {
          display: flex;
          flex-direction: column;
          line-height: 1.3;
        }
        .device-name {
          font-size: 14px;
        }
        .device-sub {
          font-size: 12px;
          color: var(--secondary-text-color);
          margin-top: 2px;
        }
        .selected-count {
          margin-top: 8px;
          font-size: 12px;
          color: var(--secondary-text-color);
        }
        button.primary {
          background: var(--primary-color);
          color: var(--text-primary-color, white);
          border: none;
          border-radius: 4px;
          padding: 10px 20px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          margin-top: 12px;
        }
        button.primary:disabled,
        button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        button {
          background: var(--secondary-background-color, #eee);
          color: var(--primary-text-color);
          border: 1px solid var(--divider-color, #ccc);
          border-radius: 4px;
          padding: 8px 16px;
          font-size: 13px;
          cursor: pointer;
          font-family: inherit;
        }
        .loading,
        .empty {
          color: var(--secondary-text-color);
          font-size: 13px;
          padding: 12px;
          text-align: center;
        }
        .error,
        .error-banner {
          color: var(--error-color, #d32f2f);
          background: rgba(211, 47, 47, 0.1);
          padding: 10px 12px;
          border-radius: 4px;
          font-size: 13px;
          margin-bottom: 12px;
        }
        .captures {
          margin-top: 16px;
          padding-top: 16px;
          border-top: 1px solid var(--divider-color, #e0e0e0);
        }
        .capture {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          padding: 6px 0;
          font-size: 13px;
        }
        .capture code {
          background: var(--secondary-background-color, #f4f4f4);
          padding: 2px 6px;
          border-radius: 3px;
          font-size: 12px;
        }
        .capture-link {
          color: var(--primary-color);
          text-decoration: none;
          flex: 1;
          min-width: 0;
        }
        .capture-right {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }
        .capture-meta {
          color: var(--secondary-text-color);
          font-size: 12px;
        }
        .capture-delete {
          background: transparent;
          border: 1px solid transparent;
          color: var(--secondary-text-color);
          padding: 2px 8px;
          font-size: 13px;
          line-height: 1;
          cursor: pointer;
          border-radius: 4px;
        }
        .capture-delete:hover {
          background: rgba(211, 47, 47, 0.12);
          color: var(--error-color, #d32f2f);
          border-color: var(--error-color, #d32f2f);
        }
        .tail-card {
          margin-top: 16px;
          padding-top: 16px;
          border-top: 1px solid var(--divider-color, #e0e0e0);
        }
        .tail-card h2 {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          gap: 8px;
        }
        .tail-paused-hint {
          font-size: 11px;
          font-weight: 400;
          letter-spacing: 0;
          text-transform: none;
          color: var(--warning-color, #ff9800);
        }
        .tail-box {
          background: var(--code-editor-background-color, #1e1e1e);
          color: var(--code-editor-text-color, #ddd);
          font-family: var(--code-font-family, ui-monospace, "SF Mono", Menlo, Consolas, monospace);
          font-size: 11px;
          line-height: 1.4;
          padding: 10px 12px;
          border-radius: 4px;
          height: clamp(220px, 40vh, 480px);
          overflow: auto;
          white-space: pre;
          margin: 0;
          word-break: normal;
          /* Firefox: force a visible thin scrollbar (HA themes sometimes hide
             it globally, and Shadow DOM does not always isolate that). */
          scrollbar-width: thin;
          scrollbar-color: var(--scrollbar-thumb-color, #888) transparent;
        }
        /* WebKit/Blink: same goal. Without this the scrollbar is auto-hide
           on macOS/iOS and not always rendered inside Shadow DOM. */
        .tail-box::-webkit-scrollbar {
          width: 10px;
          height: 10px;
        }
        .tail-box::-webkit-scrollbar-track {
          background: transparent;
        }
        .tail-box::-webkit-scrollbar-thumb {
          background: var(--scrollbar-thumb-color, #888);
          border-radius: 5px;
        }
        .tail-box::-webkit-scrollbar-thumb:hover {
          background: var(--scrollbar-thumb-hover-color, #aaa);
        }
        .tail-box.empty {
          color: var(--secondary-text-color);
          font-style: italic;
          font-family: inherit;
          font-size: 13px;
          white-space: normal;
        }
        .checkbox-row {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          color: var(--primary-text-color);
        }
      </style>
      <div class="header">
        <div class="header-left">
          ${this._narrow ? `<button id="menu-btn" class="icon-btn" title="${t.menu}" aria-label="${t.menu}">
            <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M3 6h18v2H3V6m0 5h18v2H3v-2m0 5h18v2H3v-2Z"/></svg>
          </button>` : ""}
          <h1>${t.title}</h1>
        </div>
        <button id="refresh-btn">${t.refresh}</button>
      </div>
      <div class="body">
        ${errorBanner}
        <div class="grid">
          <div class="col">
            <h2>${t.devicesHeading}</h2>
            <input
              class="filter-input"
              type="text"
              placeholder="${t.deviceFilterPlaceholder}"
              value="${this._filter.replace(/"/g, "&quot;")}"
              id="filter-input"
            />
            <div class="device-list">${this._renderDeviceList()}</div>
            <div class="selected-count">${t.deviceSelected}: ${this._selected.size}</div>
          </div>
          <div class="col">
            <h2>${t.sessionHeading}</h2>
            ${this._renderSession()}
            ${isActive ? this._renderTail() : `
              <div class="form">
                <h2>${t.formHeading}</h2>
                <div class="row">
                  <label for="endtime-input">${t.formEndTime}</label>
                  <input
                    type="datetime-local"
                    id="endtime-input"
                    value="${dateTimeInputValue(this._endTime)}"
                  />
                </div>
                <div class="row">
                  <label for="flush-input">${t.formFlushInterval}</label>
                  <input
                    type="number"
                    id="flush-input"
                    min="1"
                    max="1440"
                    value="${this._flushMinutes}"
                  />
                </div>
                <div class="row">
                  <label class="checkbox-row">
                    <input type="checkbox" id="replace-input" ${this._replaceExisting ? "checked" : ""} />
                    ${t.formReplaceExisting}
                  </label>
                </div>
                <button class="primary" id="start-btn" ${this._busy ? "disabled" : ""}>${t.formStart}</button>
              </div>
            `}
            <div class="captures">
              <h2>${t.capturesHeading}</h2>
              ${this._renderCaptures()}
            </div>
          </div>
        </div>
      </div>
    `;

    this._wireEvents();
    const list = this.shadowRoot.querySelector(".device-list");
    if (list && prevScroll) list.scrollTop = prevScroll;
  }

  _wireEvents() {
    const root = this.shadowRoot;
    const menu = root.getElementById("menu-btn");
    if (menu) menu.onclick = () => this._toggleMenu();
    const refresh = root.getElementById("refresh-btn");
    if (refresh) refresh.onclick = () => this._onRefreshClick();
    const stop = root.getElementById("stop-btn");
    if (stop) stop.onclick = () => this._onStopClick();
    const start = root.getElementById("start-btn");
    if (start) start.onclick = () => this._onStartClick();
    const filter = root.getElementById("filter-input");
    if (filter) {
      filter.oninput = (e) => this._onFilterInput(e.target.value);
    }
    const time = root.getElementById("endtime-input");
    if (time) {
      time.onchange = (e) => this._onTimeChange(e.target.value);
    }
    const flush = root.getElementById("flush-input");
    if (flush) {
      flush.onchange = (e) => this._onFlushChange(e.target.value);
    }
    const replace = root.getElementById("replace-input");
    if (replace) {
      replace.onchange = (e) => this._onReplaceChange(e.target.checked);
    }
    root.querySelectorAll('input[type="checkbox"][data-device-id]').forEach((el) => {
      el.onchange = (e) => this._onDeviceToggle(
        e.target.getAttribute("data-device-id"),
        e.target.checked,
      );
    });
    root.querySelectorAll(".capture-link[data-filename]").forEach((link) => {
      link.onclick = (e) => this._onCaptureLinkClick(e, link);
    });
    root.querySelectorAll(".capture-delete[data-filename]").forEach((btn) => {
      btn.onclick = () => this._onDeleteCapture(
        btn.getAttribute("data-filename"),
      );
    });
  }
}

customElements.define("zha-debug-capture-panel", ZhaDebugCapturePanel);
