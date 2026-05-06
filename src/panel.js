"use strict";

const DOMAIN = "zha_debug_capture";
const EVENT_SESSION_CHANGED = "zha_debug_capture_session_changed";

const I18N = {
  it: {
    title: "ZHA Debug Capture",
    refresh: "Aggiorna",
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
    formEndTime: "Orario di fine",
    formEndTimeHelpToday: "oggi",
    formEndTimeHelpTomorrow: "domani",
    formFlushInterval: "Flush ogni (minuti)",
    formReplaceExisting: "Sostituisci sessione attiva",
    formStart: "Avvia cattura",
    capturesHeading: "Capture salvate",
    capturesEmpty: "Nessun file salvato.",
    capturesDownload: "Scarica",
    errorNoDevices: "Seleziona almeno un device.",
    errorNoEndTime: "Imposta un orario di fine.",
    errorEndTimeTooFar: "L'orario di fine non può essere oltre 24h da adesso.",
    confirmStop: "Fermare la sessione di cattura attiva?",
  },
  en: {
    title: "ZHA Debug Capture",
    refresh: "Refresh",
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
    formEndTime: "End time",
    formEndTimeHelpToday: "today",
    formEndTimeHelpTomorrow: "tomorrow",
    formFlushInterval: "Flush every (min)",
    formReplaceExisting: "Replace active session",
    formStart: "Start capture",
    capturesHeading: "Saved captures",
    capturesEmpty: "No files saved.",
    capturesDownload: "Download",
    errorNoDevices: "Select at least one device.",
    errorNoEndTime: "Set an end time.",
    errorEndTimeTooFar: "End time can't be more than 24h from now.",
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

function parseTimeInput(value) {
  // value: "HH:MM" string. Returns Date today-at-HH:MM, or tomorrow if past.
  if (!value || !/^\d{1,2}:\d{2}$/.test(value)) return null;
  const [h, m] = value.split(":").map((x) => parseInt(x, 10));
  const now = new Date();
  const target = new Date(now.getTime());
  target.setHours(h, m, 0, 0);
  if (target.getTime() <= now.getTime() + 30000) {
    // If past or within 30s, assume tomorrow.
    target.setDate(target.getDate() + 1);
  }
  return target;
}

function timeInputValue(date) {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function isTomorrow(date) {
  const today = new Date();
  return date.getDate() !== today.getDate()
    || date.getMonth() !== today.getMonth()
    || date.getFullYear() !== today.getFullYear();
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
  }

  async _initialize() {
    await this._loadDevices();
    await this._refreshSession();
    await this._refreshCaptures();
    this._subscribeEvents();
    this._startStatusTicker();
    this._render();
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
  }

  _startStatusTicker() {
    // Re-render every 30s to keep the "in N min" countdown fresh.
    if (this._statusTimer) clearInterval(this._statusTimer);
    this._statusTimer = setInterval(() => {
      if (this._session && this._session.active) this._render();
    }, 30000);
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
    if (diffMs > 24 * 3600 * 1000) {
      this._error = this._t.errorEndTimeTooFar;
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

  _onDeviceToggle(deviceId, checked) {
    if (checked) this._selected.add(deviceId);
    else this._selected.delete(deviceId);
    this._render();
  }

  _onFilterInput(value) {
    this._filter = (value || "").toLowerCase();
    this._render();
  }

  _onTimeChange(value) {
    const parsed = parseTimeInput(value);
    if (parsed) this._endTime = parsed;
    this._render();
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
        <div class="meta"><span class="label">${t.sessionBuffer}</span> ${fmtBytes(this._session.buffered_bytes || 0)}</div>
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

  _renderCaptures() {
    const t = this._t;
    if (this._captures.length === 0) {
      return `<div class="empty">${t.capturesEmpty}</div>`;
    }
    return this._captures.map((c) => {
      const url = `/${DOMAIN}/captures/${encodeURIComponent(c.filename)}`;
      const when = new Date(c.modified).toLocaleString();
      return `
        <div class="capture">
          <a href="${url}" download class="capture-link">
            <code>${c.filename}</code>
          </a>
          <span class="capture-meta">${fmtBytes(c.size_bytes)} · ${when}</span>
        </div>
      `;
    }).join("");
  }

  _render() {
    const t = this._t;
    const tomorrow = isTomorrow(this._endTime);
    const helpText = tomorrow ? t.formEndTimeHelpTomorrow : t.formEndTimeHelpToday;
    const isActive = this._session && this._session.active;
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
          max-height: 60vh;
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
        }
        .capture-meta {
          color: var(--secondary-text-color);
          font-size: 12px;
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
        <h1>${t.title}</h1>
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
            ${isActive ? "" : `
              <div class="form">
                <h2>${t.formHeading}</h2>
                <div class="row">
                  <label for="endtime-input">${t.formEndTime}</label>
                  <input
                    type="time"
                    id="endtime-input"
                    value="${timeInputValue(this._endTime)}"
                  />
                  <span class="help">(${helpText})</span>
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
  }

  _wireEvents() {
    const root = this.shadowRoot;
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
  }
}

customElements.define("zha-debug-capture-panel", ZhaDebugCapturePanel);
