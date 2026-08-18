(function () {
    "use strict";

    // ---------------------------------------------------------------------
    // Fixed configuration
    // ---------------------------------------------------------------------

    const STEPMANIA_USER = "stepmania";
    const ENV_FILE = "/home/stepmania/packman/packman_env";
    const PACKMAN_DIR = "/home/stepmania/packman";
    const PACK_FOLDER = "/home/stepmania/songs";
    const PACKMAN_TMPDIR = "/home/stepmania/packman/tmp";

    const DB_CACHE_FILE = PACKMAN_DIR + "/packs_db.csv";
    const DB_META_FILE = PACKMAN_DIR + "/packs_db.updated";
    const PACKS_YAML = PACKMAN_DIR + "/packs.yaml";
    const STATUS_YAML = PACKMAN_DIR + "/pack-status.yaml";

    const PAGE_SIZE = 25;
    const REFRESH_COOLDOWN_MS = 2 * 60 * 1000;

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    let currentTab = "settings";
    let cooldownTimer = null;
    let initialLoad = true;

    const state = {
        settings: { SM_PACK_SEARCH_URL: "", PACK_YAML_URL: "", DISABLE_PACKMAN: false },
        settingsValid: false,
        dbRows: [],
        dbDate: null,
        installedIds: new Set(),
        statusById: new Map(),
        filterText: "",
        showOnlyInstalled: false,
        sortKey: "id",
        sortDir: "desc",
        page: 1,
    };

    // ---------------------------------------------------------------------
    // Small helpers
    // ---------------------------------------------------------------------

    function errMessage(err) {
        if (!err) return "unknown error";
        if (typeof err === "string") return err;
        if (err.message) return err.message;
        if (err.problem) return err.problem;
        return String(err);
    }

    function shQuote(str) {
        return "'" + String(str).replace(/'/g, "'\\''") + "'";
    }

    function isValidHttpUrl(value) {
        if (!value) return false;
        let u;
        try {
            u = new URL(value);
        } catch (e) {
            return false;
        }
        return u.protocol === "http:" || u.protocol === "https:";
    }

    function buildApiUrl(base) {
        return base.replace(/\/+$/, "") + "/api/packs";
    }

    // ---------------------------------------------------------------------
    // env-file (packman_env) parsing / writing
    // ---------------------------------------------------------------------

    function parseEnv(text) {
        const result = {};
        if (!text) return result;
        text.split("\n").forEach(line => {
            line = line.trim();
            if (!line || line.startsWith("#")) return;
            const idx = line.indexOf("=");
            if (idx === -1) return;
            const key = line.slice(0, idx).trim();
            let val = line.slice(idx + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
            result[key] = val;
        });
        return result;
    }

    function serializeEnv(values) {
        const lines = [
            "# Managed by the StepMania Packman Cockpit plugin.",
            "# Manual edits here will be overwritten the next time settings are saved.",
            "SM_PACK_SEARCH_URL=" + values.SM_PACK_SEARCH_URL,
            "PACK_YAML_URL=" + (values.PACK_YAML_URL || ""),
            "DISABLE_PACKMAN=" + values.DISABLE_PACKMAN,
            "PACKMAN_DIR=" + PACKMAN_DIR,
            "PACK_FOLDER=" + PACK_FOLDER,
            "TMPDIR=" + PACKMAN_TMPDIR,
            "",
        ];
        return lines.join("\n");
    }

    // ---------------------------------------------------------------------
    // CSV parsing (RFC4180-ish: quoted fields, embedded commas, "" escapes)
    // ---------------------------------------------------------------------

    function parseCsv(text) {
        const rows = [];
        let row = [];
        let field = "";
        let inQuotes = false;

        text = text.replace(/\r\n/g, "\n");

        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (inQuotes) {
                if (c === '"') {
                    if (text[i + 1] === '"') { field += '"'; i++; }
                    else inQuotes = false;
                } else {
                    field += c;
                }
            } else if (c === '"') {
                inQuotes = true;
            } else if (c === ",") {
                row.push(field);
                field = "";
            } else if (c === "\n") {
                row.push(field);
                rows.push(row);
                row = [];
                field = "";
            } else {
                field += c;
            }
        }
        if (field.length > 0 || row.length > 0) {
            row.push(field);
            rows.push(row);
        }
        return rows.filter(r => !(r.length === 1 && r[0].trim() === ""));
    }

    function findValue(obj, headerName) {
        const target = headerName.toLowerCase();
        for (const k of Object.keys(obj)) {
            if (k.toLowerCase() === target) return obj[k];
        }
        return "";
    }

    function csvToRows(text) {
        const rows = parseCsv(text);
        if (rows.length === 0) return [];
        const headers = rows[0].map(h => h.trim());
        const out = [];
        for (let i = 1; i < rows.length; i++) {
            const r = rows[i];
            if (r.length === 1 && r[0].trim() === "") continue;
            const obj = {};
            headers.forEach((h, idx) => { obj[h] = (r[idx] !== undefined ? r[idx].trim() : ""); });
            out.push({
                id: findValue(obj, "ID"),
                name: findValue(obj, "Pack Name"),
                songCount: findValue(obj, "Song Count"),
                raw: obj,
            });
        }
        return out;
    }

    // ---------------------------------------------------------------------
    // Minimal YAML readers for packs.yaml and pack-status.yaml
    //
    // These only understand the flat, un-nested shapes packman itself
    // produces/consumes. They are not general YAML parsers.
    // ---------------------------------------------------------------------

    function stripYamlValue(v) {
        v = v.split("#")[0].trim();
        if ((v.startsWith('"') && v.endsWith('"')) ||
            (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
        }
        return v;
    }

    function parsePacksYamlIds(text) {
        const ids = new Set();
        if (!text) return ids;
        const re = /^-\s*id:\s*(.+)$/;
        text.split("\n").forEach(line => {
            const m = re.exec(line.trim());
            if (m) ids.add(stripYamlValue(m[1]));
        });
        return ids;
    }

    // Targeted, minimal edits to packs.yaml: only the affected line is
    // added or removed, so any other entries/comments in the file are
    // left untouched.

    function ensurePacksYamlHeader(lines) {
        if (!lines.some(l => l.trim().startsWith("packs:"))) {
            lines = ["packs:"].concat(lines);
        }
        return lines;
    }

    function addPackToYamlText(text, id, name) {
        let lines = (text || "").split("\n");
        while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
        lines = ensurePacksYamlHeader(lines);

        const already = lines.some(l => {
            const m = /^-\s*id:\s*(.+)$/.exec(l.trim());
            return m && stripYamlValue(m[1]) === String(id);
        });
        if (!already) {
            const comment = name ? " # " + String(name).replace(/[\r\n#]/g, " ").trim() : "";
            lines.push("- id: " + id + comment);
        }
        return lines.join("\n") + "\n";
    }

    function removePackFromYamlText(text, id) {
        let lines = (text || "").split("\n");
        lines = lines.filter(l => {
            const m = /^-\s*id:\s*(.+)$/.exec(l.trim());
            if (!m) return true;
            return stripYamlValue(m[1]) !== String(id);
        });
        while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
        return lines.join("\n") + "\n";
    }

    function parseStatusYaml(text) {
        const map = new Map();
        if (!text) return map;
        let current = null;

        const flush = () => {
            if (current && current.id !== undefined) map.set(String(current.id), current);
        };

        text.split("\n").forEach(rawLine => {
            const line = rawLine.trim();
            if (line.startsWith("- id:")) {
                flush();
                current = { id: stripYamlValue(line.slice("- id:".length)) };
            } else if (current && line.startsWith("id:")) {
                current.id = stripYamlValue(line.slice("id:".length));
            } else if (current && line.startsWith("name:")) {
                current.name = stripYamlValue(line.slice("name:".length));
            } else if (current && line.startsWith("status:")) {
                current.status = stripYamlValue(line.slice("status:".length));
            }
        });
        flush();
        return map;
    }

    // ---------------------------------------------------------------------
    // Cockpit file I/O (privileged, since /home/stepmania belongs to
    // the "stepmania" user, not necessarily the logged-in cockpit user)
    // ---------------------------------------------------------------------

    function fileRead(path) {
        const file = cockpit.file(path, { superuser: "try" });
        return file.read().then(
            content => { file.close(); return content; },
            err => { file.close(); throw err; }
        );
    }

    function fileWrite(path, content) {
        const file = cockpit.file(path, { superuser: "try" });
        return file.replace(content).then(
            tag => { file.close(); return tag; },
            err => { file.close(); throw err; }
        );
    }

    function downloadUrl(url) {
        return cockpit.spawn(["curl", "-fsSL", "--max-time", "30", url], { err: "message" })
            .catch(err => {
                if (err && err.problem === "not-found") {
                    throw new Error('"curl" was not found on this system. Install it (e.g. "apt install curl") and try again.');
                }
                throw new Error("Could not download the pack database: " + errMessage(err));
            });
    }

    // A light structural check for packs.yaml: every non-empty, non-comment
    // line must be either the "packs:" header or a "- id: <value>" entry —
    // the only two shapes packman itself understands.
    function looksLikeValidPacksYaml(text) {
        if (!text || !text.trim()) return false;
        const lines = text.split("\n").map(l => l.trim());
        let sawPacksKey = false;
        let sawIdEntry = false;
        for (const line of lines) {
            if (!line || line.startsWith("#")) continue;
            if (line.startsWith("packs:")) { sawPacksKey = true; continue; }
            if (/^-\s*id:\s*\S+/.test(line)) { sawIdEntry = true; continue; }
            return false;
        }
        return sawPacksKey || sawIdEntry;
    }

    function checkPackYamlUrl(url) {
        setInlineStatus("yaml-url-check-status", "Checking pack list URL…", "");
        return cockpit.spawn(["curl", "-fsSL", "--max-time", "30", url], { err: "message" })
            .catch(err => {
                throw new Error("could not download it (" + errMessage(err) + ")");
            })
            .then(text => {
                if (!looksLikeValidPacksYaml(text)) {
                    throw new Error("downloaded content doesn't look like a valid packs.yaml");
                }
                setInlineStatus("yaml-url-check-status", "Pack list URL looks good.", "success");
            })
            .catch(err => {
                setInlineStatus("yaml-url-check-status", "Pack list URL check failed: " + errMessage(err), "error");
            });
    }

    function ensurePackmanDir() {
        return cockpit.spawn(["mkdir", "-p", PACKMAN_DIR], { superuser: "try", err: "message" })
            .catch(err => {
                throw new Error("Could not create " + PACKMAN_DIR + ": " + errMessage(err));
            })
            .then(() => cockpit.spawn(["chown", STEPMANIA_USER + ":" + STEPMANIA_USER, PACKMAN_DIR],
                                       { superuser: "try", err: "message" })
                .catch(() => { /* best effort — ownership may already be correct, or we may lack chown rights */ }));
    }

    // ---------------------------------------------------------------------
    // UI helpers
    // ---------------------------------------------------------------------

    function showAlert(message, kind) {
        const el = document.getElementById("pm-global-alert");
        el.textContent = message;
        el.className = "pm-alert" +
            (kind === "error" ? " pm-alert-error" : kind === "success" ? " pm-alert-success" : "");
        el.hidden = false;
        clearTimeout(showAlert._t);
        if (kind !== "error") {
            showAlert._t = setTimeout(() => { el.hidden = true; }, 6000);
        }
    }

    function setInlineStatus(id, text, kind) {
        const el = document.getElementById(id);
        el.textContent = text;
        el.className = "pm-inline-status" +
            (kind === "error" ? " pm-status-error" : kind === "success" ? " pm-status-success" : "");
    }

    function setBusy(busy, btnId, busyLabel) {
        const btn = document.getElementById(btnId);
        if (!btn) return;
        if (busy) {
            btn.dataset.origLabel = btn.textContent;
            if (busyLabel) btn.textContent = busyLabel;
            btn.disabled = true;
        } else {
            btn.textContent = btn.dataset.origLabel || btn.textContent;
            btn.disabled = false;
        }
    }

    function setFieldError(key, message) {
        const input = document.querySelector('[name="' + key + '"]');
        if (input) input.classList.add("pm-invalid");
        const err = document.querySelector('[data-error-for="' + key + '"]');
        if (err) { err.textContent = message; err.hidden = false; }
    }

    function clearFieldErrors() {
        document.querySelectorAll(".pm-invalid").forEach(el => el.classList.remove("pm-invalid"));
        document.querySelectorAll(".pm-error").forEach(el => { el.hidden = true; el.textContent = ""; });
    }

    function showRunOutput(title) {
        document.getElementById("run-output-wrap").hidden = false;
        document.getElementById("run-output-title").textContent = title;
    }

    function clearRunOutput() {
        document.getElementById("run-output").textContent = "";
    }

    function appendRunOutput(text) {
        const pre = document.getElementById("run-output");
        pre.textContent += text;
        pre.scrollTop = pre.scrollHeight;
    }

    // ---------------------------------------------------------------------
    // Tabs
    // ---------------------------------------------------------------------

    function switchTab(name) {
        if (name === "packs" && !state.settingsValid) name = "settings";
        currentTab = name;
        document.querySelectorAll(".pm-tab").forEach(btn => {
            const active = btn.dataset.tab === name;
            btn.classList.toggle("active", active);
            btn.setAttribute("aria-selected", active ? "true" : "false");
        });
        document.getElementById("panel-settings").hidden = name !== "settings";
        document.getElementById("panel-packs").hidden = name !== "packs";
    }

    function updatePacksGate() {
        document.getElementById("packs-tab-btn").disabled = !state.settingsValid;

        const gate = document.getElementById("packs-gate");
        const content = document.getElementById("packs-content");
        const disabledNote = document.getElementById("disabled-note");

        if (state.settingsValid) {
            gate.hidden = true;
            content.hidden = false;
            disabledNote.hidden = !state.settings.DISABLE_PACKMAN;
            loadPacksData();
            if (initialLoad) switchTab("packs");
        } else {
            gate.hidden = false;
            content.hidden = true;
            if (currentTab === "packs") switchTab("settings");
        }
        initialLoad = false;
    }

    // ---------------------------------------------------------------------
    // Settings tab
    // ---------------------------------------------------------------------

    function loadSettings() {
        return fileRead(ENV_FILE)
            .then(text => {
                const env = parseEnv(text || "");
                state.settings.SM_PACK_SEARCH_URL = env.SM_PACK_SEARCH_URL || "";
                state.settings.PACK_YAML_URL = env.PACK_YAML_URL || "";
                state.settings.DISABLE_PACKMAN = (env.DISABLE_PACKMAN || "false").toLowerCase() === "true";

                document.getElementById("fld-search-url").value = state.settings.SM_PACK_SEARCH_URL;
                document.getElementById("fld-yaml-url").value = state.settings.PACK_YAML_URL;
                const radioValue = state.settings.DISABLE_PACKMAN ? "true" : "false";
                document.querySelector('input[name="DISABLE_PACKMAN"][value="' + radioValue + '"]').checked = true;

                state.settingsValid = isValidHttpUrl(state.settings.SM_PACK_SEARCH_URL);
                updatePacksGate();
            })
            .catch(err => {
                showAlert("Could not read " + ENV_FILE + ": " + errMessage(err), "error");
            });
    }

    function onSaveSettings(evt) {
        evt.preventDefault();
        clearFieldErrors();

        const searchUrl = document.getElementById("fld-search-url").value.trim();
        const yamlUrl = document.getElementById("fld-yaml-url").value.trim();
        const disable = document.querySelector('input[name="DISABLE_PACKMAN"]:checked').value === "true";

        let ok = true;
        if (!isValidHttpUrl(searchUrl)) {
            setFieldError("SM_PACK_SEARCH_URL", "Enter a valid http:// or https:// URL.");
            ok = false;
        }
        if (yamlUrl && !isValidHttpUrl(yamlUrl)) {
            setFieldError("PACK_YAML_URL", "Enter a valid http:// or https:// URL, or leave this blank.");
            ok = false;
        }
        if (!ok) return;

        setBusy(true, "btn-save-settings", "Saving…");
        setInlineStatus("settings-save-status", "", "");

        const content = serializeEnv({
            SM_PACK_SEARCH_URL: searchUrl,
            PACK_YAML_URL: yamlUrl,
            DISABLE_PACKMAN: disable ? "true" : "false",
        });

        ensurePackmanDir()
            .then(() => fileWrite(ENV_FILE, content))
            .then(() => cockpit.spawn(["chown", STEPMANIA_USER + ":" + STEPMANIA_USER, ENV_FILE],
                                       { superuser: "try", err: "message" }).catch(() => {}))
            .then(() => cockpit.spawn(["chmod", "640", ENV_FILE],
                                       { superuser: "try", err: "message" }).catch(() => {}))
            .then(() => {
                state.settings = { SM_PACK_SEARCH_URL: searchUrl, PACK_YAML_URL: yamlUrl, DISABLE_PACKMAN: disable };
                state.settingsValid = true;
                updatePacksGate();
                setInlineStatus("settings-save-status", "Saved.", "success");
                showAlert("Settings saved to " + ENV_FILE + ".", "success");

                // Best-effort check — this doesn't undo the save if it fails.
                if (yamlUrl) {
                    checkPackYamlUrl(yamlUrl);
                } else {
                    setInlineStatus("yaml-url-check-status", "", "");
                }
            })
            .catch(err => {
                setInlineStatus("settings-save-status", "Save failed.", "error");
                showAlert("Failed to save settings: " + errMessage(err), "error");
            })
            .finally(() => setBusy(false, "btn-save-settings"));
    }

    // ---------------------------------------------------------------------
    // Packs tab: database refresh / packman run / list rendering
    // ---------------------------------------------------------------------

    function renderDbDate() {
        const el = document.getElementById("db-date");
        if (!state.dbDate) {
            el.textContent = "never downloaded";
            return;
        }
        const d = new Date(state.dbDate);
        el.textContent = isNaN(d.getTime()) ? state.dbDate : d.toLocaleString();
    }

    function refreshCooldownRemainingMs() {
        if (!state.dbDate) return 0;
        const last = new Date(state.dbDate).getTime();
        if (isNaN(last)) return 0;
        return REFRESH_COOLDOWN_MS - (Date.now() - last);
    }

    function updateRefreshCooldownUI() {
        clearInterval(cooldownTimer);
        const btn = document.getElementById("btn-refresh-db");
        const note = document.getElementById("refresh-cooldown-note");

        function tick() {
            const remaining = refreshCooldownRemainingMs();
            if (remaining <= 0) {
                clearInterval(cooldownTimer);
                btn.disabled = false;
                note.hidden = true;
                return;
            }
            btn.disabled = true;
            note.hidden = false;
            note.textContent = "Refreshed recently — available again in " + Math.ceil(remaining / 1000) + "s";
        }

        tick();
        if (refreshCooldownRemainingMs() > 0) {
            cooldownTimer = setInterval(tick, 1000);
        }
    }

    function compareRows(a, b) {
        let cmp;
        if (state.sortKey === "id") {
            const an = Number(a.id);
            const bn = Number(b.id);
            cmp = (!isNaN(an) && !isNaN(bn)) ? an - bn : String(a.id).localeCompare(String(b.id));
        } else {
            cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        }
        return state.sortDir === "desc" ? -cmp : cmp;
    }

    function getFilteredRows() {
        const q = state.filterText.trim().toLowerCase();
        let rows = state.dbRows;
        if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q));
        if (state.showOnlyInstalled) rows = rows.filter(r => state.installedIds.has(String(r.id)));
        return rows.slice().sort(compareRows);
    }

    function onSortButtonClick(key) {
        if (state.sortKey === key) {
            state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        } else {
            state.sortKey = key;
            state.sortDir = key === "id" ? "desc" : "asc";
        }
        state.page = 1;
        updateSortButtons();
        renderTable();
    }

    function updateSortButtons() {
        document.querySelectorAll(".pm-sort-btn").forEach(btn => {
            const key = btn.dataset.sort;
            const arrow = btn.querySelector(".pm-sort-arrow");
            const active = key === state.sortKey;
            btn.classList.toggle("pm-sort-btn-active", active);
            if (arrow) arrow.textContent = active ? (state.sortDir === "asc" ? "\u25B2" : "\u25BC") : "";
        });
    }

    function renderTable() {
        const rows = getFilteredRows();
        const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
        if (state.page > totalPages) state.page = totalPages;
        if (state.page < 1) state.page = 1;

        const start = (state.page - 1) * PAGE_SIZE;
        const pageRows = rows.slice(start, start + PAGE_SIZE);

        const tbody = document.getElementById("packs-tbody");
        tbody.textContent = "";

        if (pageRows.length === 0) {
            const tr = document.createElement("tr");
            tr.className = "pm-empty-row";
            const td = document.createElement("td");
            td.colSpan = 4;
            td.textContent = state.dbRows.length === 0
                ? 'No pack database loaded yet. Click "Refresh database".'
                : "No packs match your search.";
            tr.appendChild(td);
            tbody.appendChild(tr);
        } else {
            pageRows.forEach(row => {
                const tr = document.createElement("tr");

                const tdName = document.createElement("td");
                tdName.textContent = row.name;
                tr.appendChild(tdName);

                const tdCount = document.createElement("td");
                tdCount.textContent = row.songCount;
                tr.appendChild(tdCount);

                const installed = state.installedIds.has(String(row.id));
                const tdInstalled = document.createElement("td");
                const cell = document.createElement("div");
                cell.className = "pm-toggle-cell";

                const toggle = document.createElement("button");
                toggle.type = "button";
                toggle.className = "pm-toggle" + (installed ? " pm-toggle-on" : "");
                toggle.setAttribute("role", "switch");
                toggle.setAttribute("aria-checked", installed ? "true" : "false");
                toggle.title = installed
                    ? "Installed — click to remove from packs.yaml"
                    : "Not installed — click to add to packs.yaml";
                const knob = document.createElement("span");
                knob.className = "pm-toggle-knob";
                toggle.appendChild(knob);
                toggle.addEventListener("click", () => onToggleInstalled(row, !installed, toggle));
                cell.appendChild(toggle);

                const label = document.createElement("span");
                label.textContent = installed ? "Yes" : "No";
                cell.appendChild(label);

                tdInstalled.appendChild(cell);
                tr.appendChild(tdInstalled);

                const statusEntry = state.statusById.get(String(row.id));
                const tdState = document.createElement("td");
                tdState.textContent = statusEntry && statusEntry.status ? statusEntry.status : "—";
                tr.appendChild(tdState);

                tbody.appendChild(tr);
            });
        }

        document.getElementById("page-indicator").textContent =
            "Page " + state.page + " of " + totalPages;

        let countText = rows.length + (rows.length === 1 ? " pack" : " packs");
        countText += state.filterText ? " matching" : " total";
        if (state.dbRows.length !== rows.length) {
            countText += " (" + state.dbRows.length + " total)";
        }
        document.getElementById("pack-count").textContent = countText;

        document.getElementById("btn-prev-page").disabled = state.page <= 1;
        document.getElementById("btn-next-page").disabled = state.page >= totalPages;
    }

    function loadPacksData() {
        return Promise.all([
            fileRead(DB_CACHE_FILE).catch(() => null),
            fileRead(DB_META_FILE).catch(() => null),
            fileRead(PACKS_YAML).catch(() => null),
            fileRead(STATUS_YAML).catch(() => null),
        ]).then(([csvText, metaText, packsYamlText, statusYamlText]) => {
            state.dbRows = csvText ? csvToRows(csvText) : [];
            state.dbDate = metaText ? metaText.trim() : null;
            state.installedIds = parsePacksYamlIds(packsYamlText || "");
            state.statusById = parseStatusYaml(statusYamlText || "");
            state.page = 1;
            renderDbDate();
            updateRefreshCooldownUI();
            renderTable();
        });
    }

    function togglePackInstalled(row, installNow) {
        return ensurePackmanDir()
            .then(() => fileRead(PACKS_YAML))
            .then(text => {
                const newText = installNow
                    ? addPackToYamlText(text, row.id, row.name)
                    : removePackFromYamlText(text, row.id);
                return fileWrite(PACKS_YAML, newText);
            })
            .then(() => cockpit.spawn(["chown", STEPMANIA_USER + ":" + STEPMANIA_USER, PACKS_YAML],
                                       { superuser: "try", err: "message" }).catch(() => {}))
            .then(() => {
                const id = String(row.id);
                if (installNow) state.installedIds.add(id);
                else state.installedIds.delete(id);
            });
    }

    function onToggleInstalled(row, installNow, toggleEl) {
        toggleEl.disabled = true;
        togglePackInstalled(row, installNow)
            .then(() => {
                showAlert(
                    (installNow ? "Added " : "Removed ") + row.name +
                    (installNow ? " to packs.yaml." : " from packs.yaml."),
                    "success"
                );
                renderTable();
            })
            .catch(err => {
                showAlert("Could not update packs.yaml: " + errMessage(err), "error");
                toggleEl.disabled = false;
            });
    }

    function refreshDatabase() {
        if (!state.settingsValid) return;

        if (refreshCooldownRemainingMs() > 0) {
            showAlert("The database was refreshed less than 2 minutes ago — please wait before refreshing again.", "error");
            return;
        }

        setBusy(true, "btn-refresh-db", "Refreshing…");

        const apiUrl = buildApiUrl(state.settings.SM_PACK_SEARCH_URL);

        ensurePackmanDir()
            .then(() => downloadUrl(apiUrl))
            .then(csvText => fileWrite(DB_CACHE_FILE, csvText))
            .then(() => fileWrite(DB_META_FILE, new Date().toISOString()))
            .then(() => loadPacksData())
            .then(() => showAlert("Pack database refreshed.", "success"))
            .catch(err => showAlert("Failed to refresh the pack database: " + errMessage(err), "error"))
            .finally(() => setBusy(false, "btn-refresh-db"));
    }

    function runPackman() {
        if (!state.settingsValid) return;
        setBusy(true, "btn-run-packman", "Running…");
        showRunOutput("Packman output");
        clearRunOutput();

        const script = "set -a; . " + shQuote(ENV_FILE) + "; set +a; exec packman";
        const cmd = ["bash", "-lc", script];

        const proc = cockpit.spawn(cmd, { err: "out", pty: true });
        proc.stream(data => appendRunOutput(data));
        proc
            .then(() => {
                appendRunOutput("\n[packman finished]\n");
                showAlert("Packman run completed.", "success");
                return loadPacksData();
            })
            .catch(err => {
                appendRunOutput("\n[packman exited with an error: " + errMessage(err) + "]\n");
                showAlert("Packman run failed: " + errMessage(err), "error");
            })
            .finally(() => setBusy(false, "btn-run-packman"));
    }

    // ---------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------

    function init() {
        document.getElementById("static-packman-dir").textContent = PACKMAN_DIR;
        document.getElementById("static-pack-folder").textContent = PACK_FOLDER;
        document.getElementById("static-tmpdir").textContent = PACKMAN_TMPDIR;

        document.querySelectorAll(".pm-tab").forEach(btn => {
            btn.addEventListener("click", () => switchTab(btn.dataset.tab));
        });
        document.getElementById("btn-goto-settings").addEventListener("click", () => switchTab("settings"));

        document.getElementById("settings-form").addEventListener("submit", onSaveSettings);

        document.getElementById("btn-refresh-db").addEventListener("click", refreshDatabase);
        document.getElementById("btn-run-packman").addEventListener("click", runPackman);
        document.getElementById("btn-close-output").addEventListener("click", () => {
            document.getElementById("run-output-wrap").hidden = true;
        });

        document.querySelectorAll(".pm-sort-btn").forEach(btn => {
            btn.addEventListener("click", () => onSortButtonClick(btn.dataset.sort));
        });
        updateSortButtons();

        document.getElementById("pack-search").addEventListener("input", evt => {
            state.filterText = evt.target.value;
            state.page = 1;
            renderTable();
        });
        document.getElementById("show-installed-only").addEventListener("change", evt => {
            state.showOnlyInstalled = evt.target.checked;
            state.page = 1;
            renderTable();
        });
        document.getElementById("btn-prev-page").addEventListener("click", () => {
            state.page -= 1;
            renderTable();
        });
        document.getElementById("btn-next-page").addEventListener("click", () => {
            state.page += 1;
            renderTable();
        });

        loadSettings();
    }

    document.addEventListener("DOMContentLoaded", init);
})();
