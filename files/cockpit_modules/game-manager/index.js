(function () {
    "use strict";

    // Source of truth for available game releases.
    const YAML_URL = "https://raw.githubusercontent.com/sergioperez/stepmania-cabinet-tools/refs/heads/release/group_vars/all";

    // Games already on the system but not necessarily part of the release
    // list above are detected by looking for one of these binaries (case
    // insensitive) directly inside a subdirectory of LOCAL_GAME_DIR.
    const LOCAL_GAME_DIR = "/home/stepmania/game";
    const LOCAL_BINARY_NAMES = ["deadsync", "stepmania", "outfox", "itgmania", "openitg", "etterna"];

    // The script the kiosk launches; whichever known binary path appears in
    // here is the "current" game.
    const RUN_GAME_SCRIPT = "/home/stepmania/run_game.sh";

    // If this file exists and sets DISABLE_GAME_DOWNLOAD=true, the release
    // list is never fetched at all - only installed games are shown.
    const SETTINGS_ENV = "/home/stepmania/settings.env";

    const installedListEl = document.getElementById("installed-list");
    const installedEmptyEl = document.getElementById("installed-empty");
    const availableSectionEl = document.getElementById("available-section");
    const availableListEl = document.getElementById("available-list");
    const statusEl = document.getElementById("status-bar");
    const refreshBtn = document.getElementById("refresh-btn");
    const termPanel = document.getElementById("terminal-panel");
    const termTitle = document.getElementById("terminal-title");
    const termOutput = document.getElementById("terminal-output");
    const termClose = document.getElementById("terminal-close");

    let games = {};             // id -> release object from game_releases
    let localArch = null;       // normalized: x86_64 / arm64 / riscv64 / ...
    let installed = {};         // id -> bool
    let localGameDirs = [];     // raw scan results: [{dir, binary}, ...]
    let localOnly = [];         // ids of games found on disk but not in game_releases (or not for this arch)
    let localBinaryPaths = {};  // id -> binary path, for ids in localOnly
    let runGameContent = "";    // last-read content of RUN_GAME_SCRIPT
    let current = null;         // id of the currently selected (running) game, or null
    let busy = false;           // true while a download is running

    function setStatus(text, isError) {
        statusEl.textContent = text || "";
        statusEl.classList.toggle("gd-status-error", !!isError);
    }

    // Single-quote a value for safe use inside a bash -c script.
    function shQuote(str) {
        return "'" + String(str).replace(/'/g, "'\\''") + "'";
    }

    // The YAML keys its urls by "x86_64" / "arm64" / "riscv64". `uname -m`
    // reports "aarch64" on 64-bit ARM, so normalize that one case; everything
    // else is passed through unchanged.
    function normalizeArch(raw) {
        raw = (raw || "").trim();
        if (raw === "aarch64")
            return "arm64";
        return raw;
    }

    function detectArch() {
        return cockpit.spawn(["uname", "-m"], { err: "message" })
            .then((out) => normalizeArch(out));
    }

    // True if any interface besides loopback has an operational link (its
    // carrier is actually up), not just the administrative UP flag — a NIC
    // like enp1s0 can be admin-enabled with no cable plugged in, in which
    // case `ip link show up` would still match it even though `ip link`
    // itself reports it as "state DOWN". /sys/class/net/*/operstate
    // reflects the real link state instead.
    function hasNetworkLink() {
        const script = [
            "for f in /sys/class/net/*/operstate; do",
            "  iface=$(basename \"$(dirname \"$f\")\")",
            "  [ \"$iface\" = \"lo\" ] && continue",
            "  [ \"$(cat \"$f\" 2>/dev/null)\" = \"up\" ] && { echo yes; exit 0; }",
            "done",
            "echo no"
        ].join("\n");
        return cockpit.spawn(["bash", "-c", script], { err: "ignore" })
            .then((out) => out.trim() !== "no")
            .catch(() => true); // couldn't tell (e.g. /sys unavailable) - don't assume offline
    }

    function fetchReleases() {
        const script = "set -o pipefail; curl -fsSL --max-time 10 " + shQuote(YAML_URL) + " | yq '.game_releases'";
        return cockpit.spawn(["bash", "-c", script], { err: "message" })
            .then((out) => JSON.parse(out));
    }

    // A game counts as installed if its "dest" directory exists and isn't empty.
    function checkInstalled(entries) {
        const ids = Object.keys(entries);
        if (ids.length === 0)
            return Promise.resolve({});

        const lines = ids.map((id) => {
            const dest = shQuote(entries[id].dest);
            return "if [ -d " + dest + " ] && [ -n \"$(ls -A " + dest + " 2>/dev/null)\" ]; then echo " +
                shQuote(id + ":yes") + "; else echo " + shQuote(id + ":no") + "; fi";
        });

        return cockpit.spawn(["bash", "-c", lines.join("\n")], { err: "message" })
            .then((out) => {
                const result = {};
                out.split("\n").forEach((line) => {
                    line = line.trim();
                    if (!line)
                        return;
                    const idx = line.lastIndexOf(":");
                    if (idx === -1)
                        return;
                    result[line.slice(0, idx)] = line.slice(idx + 1) === "yes";
                });
                return result;
            });
    }

    // Finds subdirectories of LOCAL_GAME_DIR that directly contain one of
    // LOCAL_BINARY_NAMES (case insensitive). Returns {dir, binary} pairs
    // with full absolute paths. No architecture check involved anywhere
    // here — a matching binary alone means the game is installed.
    function scanLocalGames() {
        const nameTests = LOCAL_BINARY_NAMES.map((n) => "-iname " + shQuote(n)).join(" -o ");
        const script = [
            "for d in " + shQuote(LOCAL_GAME_DIR) + "/*/; do",
            "  [ -d \"$d\" ] || continue",
            "  d=\"${d%/}\"",
            "  m=$(find \"$d\" -maxdepth 1 -type f \\( " + nameTests + " \\) -print -quit)",
            "  [ -n \"$m\" ] && echo \"$d|$m\"",
            "done"
        ].join("\n");

        return cockpit.spawn(["bash", "-c", script], { err: "message" })
            .then((out) => out.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
                const idx = line.indexOf("|");
                return { dir: line.slice(0, idx), binary: line.slice(idx + 1) };
            }))
            .catch(() => []); // e.g. LOCAL_GAME_DIR doesn't exist yet
    }

    function readRunGameScript() {
        return cockpit.spawn(["cat", RUN_GAME_SCRIPT], { err: "ignore" })
            .catch(() => "");
    }

    // True if SETTINGS_ENV exists and sets DISABLE_GAME_DOWNLOAD=true
    // (optionally quoted/spaced), in which case the release list should
    // never be fetched at all.
    function isGameDownloadDisabled() {
        const pattern = "^[[:space:]]*DISABLE_GAME_DOWNLOAD[[:space:]]*=[[:space:]]*\"?true\"?[[:space:]]*$";
        const script = "if [ -f " + shQuote(SETTINGS_ENV) + " ] && grep -Eq " + shQuote(pattern) + " " +
            shQuote(SETTINGS_ENV) + "; then echo yes; else echo no; fi";
        return cockpit.spawn(["bash", "-c", script], { err: "ignore" })
            .then((out) => out.trim() === "yes")
            .catch(() => false);
    }

    // Full binary path for a known id, whether it came from the release
    // list or from the local disk scan.
    function binaryPathForId(id) {
        if (games[id])
            return games[id].binary_path;
        return localBinaryPaths[id];
    }

    // Install directory for a known id.
    function destForId(id) {
        return games[id] ? games[id].dest : (LOCAL_GAME_DIR + "/" + id);
    }

    // The "current" game is whichever installed one has its binary path
    // appearing in RUN_GAME_SCRIPT's content.
    function computeCurrent() {
        const candidates = Object.keys(games).filter((id) => installed[id]).concat(localOnly);
        current = candidates.find((id) => {
            const bp = binaryPathForId(id);
            return bp && runGameContent.indexOf(bp) !== -1;
        }) || null;
    }

    // Applies a set of {dir, binary} local-scan results (already deduped
    // against known game_releases dests, if applicable) to localOnly / localBinaryPaths.
    function applyLocalOnly(items) {
        localOnly = items.map((o) => o.dir.split("/").pop());
        localBinaryPaths = {};
        items.forEach((o) => { localBinaryPaths[o.dir.split("/").pop()] = o.binary; });
    }

    function downloadIcon() {
        return '<svg class="gd-icon" viewBox="0 0 16 16"><path d="M8 1a.5.5 0 0 1 .5.5v7.79l2.15-2.15a.5.5 0 1 1 .7.71l-3 3a.5.5 0 0 1-.7 0l-3-3a.5.5 0 1 1 .7-.71L7.5 9.29V1.5A.5.5 0 0 1 8 1zM2 13.5a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5z"/></svg>';
    }

    function trashIcon() {
        return '<svg class="gd-icon" viewBox="0 0 16 16"><path d="M6 1.5a1 1 0 0 0-1 1V3H2.5a.5.5 0 0 0 0 1H3v9a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V4h.5a.5.5 0 0 0 0-1H11v-.5a1 1 0 0 0-1-1H6zM6 3v-.5h4V3H6zM4 4h8v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4zm2 2a.5.5 0 0 0-.5.5v5a.5.5 0 0 0 1 0v-5A.5.5 0 0 0 6 6zm4 0a.5.5 0 0 0-.5.5v5a.5.5 0 0 0 1 0v-5A.5.5 0 0 0 10 6z"/></svg>';
    }

    // Appends one row to `container`. opts:
    //   isCurrent:     bool
    //   onDownload:    fn|null - shows a Download button when set
    //   onRemove:      fn|null - shows a remove (trash) button when set
    //   onMakeCurrent: fn|null - makes the whole row clickable when set
    function addRow(container, id, opts) {
        const row = document.createElement("div");
        row.className = "gd-row" + (opts.isCurrent ? " gd-row-current" : "");

        if (opts.onMakeCurrent) {
            row.classList.add("gd-row-clickable");
            row.title = opts.isCurrent ? "This is the current game" : "Click to make this the current game";
            row.addEventListener("click", () => opts.onMakeCurrent());
        }

        const nameEl = document.createElement("div");
        nameEl.className = "gd-name" + (opts.isCurrent ? " gd-name-current" : "");
        nameEl.textContent = id;
        row.appendChild(nameEl);

        const badges = document.createElement("div");
        badges.className = "gd-badges";

        if (opts.isCurrent) {
            const cur = document.createElement("span");
            cur.className = "gd-current-badge";
            cur.textContent = "Current";
            badges.appendChild(cur);
        }
        row.appendChild(badges);

        const action = document.createElement("div");
        action.className = "gd-action";

        if (opts.onDownload) {
            const btn = document.createElement("button");
            btn.className = "gd-btn gd-btn-primary";
            btn.innerHTML = downloadIcon() + " Download";
            btn.disabled = busy;
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                opts.onDownload();
            });
            action.appendChild(btn);
        }

        if (opts.onRemove) {
            const rm = document.createElement("button");
            rm.className = "gd-btn gd-btn-danger";
            rm.innerHTML = trashIcon();
            if (opts.isCurrent) {
                rm.disabled = true;
                rm.title = "Can't remove the current game";
            } else {
                rm.title = "Remove " + id;
                rm.addEventListener("click", (e) => {
                    e.stopPropagation();
                    opts.onRemove();
                });
            }
            action.appendChild(rm);
        }

        row.appendChild(action);
        container.appendChild(row);
    }

    function renderInstalled() {
        installedListEl.innerHTML = "";

        const installedFromReleases = Object.keys(games).filter((id) => installed[id]);
        const installedIds = installedFromReleases.concat(localOnly);

        installedEmptyEl.hidden = installedIds.length !== 0;
        if (installedIds.length === 0) {
            installedEmptyEl.textContent = "No installed games were found under " + LOCAL_GAME_DIR + ".";
            return;
        }

        installedIds.forEach((id) => {
            addRow(installedListEl, id, {
                isCurrent: id === current,
                onDownload: null,
                onRemove: () => removeGame(id),
                onMakeCurrent: () => makeCurrent(id)
            });
        });
    }

    function renderAvailable() {
        availableListEl.innerHTML = "";

        const availableIds = Object.keys(games)
            .filter((id) => games[id].url && games[id].url[localArch] && !installed[id]);

        availableSectionEl.hidden = availableIds.length === 0;
        availableIds.forEach((id) => {
            addRow(availableListEl, id, {
                isCurrent: false,
                onDownload: () => startDownload(id),
                onRemove: null,
                onMakeCurrent: null
            });
        });
    }

    function render() {
        renderInstalled();
        renderAvailable();
    }

    // --- minimal terminal-style output panel ---

    let termLines = [""];

    function resetTerminal(title) {
        termLines = [""];
        termOutput.textContent = "";
        termTitle.textContent = title;
        termClose.hidden = true;
        termPanel.hidden = false;
    }

    function stripAnsi(str) {
        return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    }

    // Handles \r the way a real terminal would (start overwriting the
    // current line), which is what makes curl's progress bar readable.
    function termWrite(chunk) {
        chunk = stripAnsi(chunk);
        for (let i = 0; i < chunk.length; i++) {
            const ch = chunk[i];
            if (ch === "\r") {
                termLines[termLines.length - 1] = "";
            } else if (ch === "\n") {
                termLines.push("");
            } else {
                termLines[termLines.length - 1] += ch;
            }
        }
        if (termLines.length > 500)
            termLines = termLines.slice(-500);
        termOutput.textContent = termLines.join("\n");
        termOutput.scrollTop = termOutput.scrollHeight;
    }

    termClose.addEventListener("click", () => {
        termPanel.hidden = true;
    });

    // --- download / install flow ---

    function startDownload(id) {
        if (busy)
            return;

        const entry = games[id];
        const url = entry.url[localArch];
        const dest = entry.dest;
        const extractOpts = (entry.extract_opts || []).map(shQuote).join(" ");
        const tmpFile = "/tmp/game-manager-" + id.replace(/[^A-Za-z0-9_.-]/g, "_") + ".archive";

        busy = true;
        render();
        resetTerminal("Downloading " + id + "\u2026");

        const script = [
            "set -e",
            "mkdir -p " + shQuote(dest),
            "curl -fL --progress-bar -o " + shQuote(tmpFile) + " " + shQuote(url),
            "tar -xf " + shQuote(tmpFile) + " -C " + shQuote(dest) + (extractOpts ? " " + extractOpts : ""),
            "rm -f " + shQuote(tmpFile),
            "echo",
            "echo 'Done.'"
        ].join("\n");

        const proc = cockpit.spawn(["bash", "-c", script], { pty: true, err: "out" });
        proc.stream((data) => termWrite(data));
        proc.then(() => {
            termWrite("\n\u2713 " + id + " installed successfully.\n");
            busy = false;
            termClose.hidden = false;
            return loadAll();
        }).catch((ex) => {
            termWrite("\n\u2717 Failed: " + (ex && (ex.message || ex.problem) || String(ex)) + "\n");
            busy = false;
            termClose.hidden = false;
            render();
        });
    }

    // --- remove ---

    function removeGame(id) {
        if (busy) {
            setStatus("Please wait for the current operation to finish.", true);
            return;
        }
        if (id === current) {
            setStatus("Can't remove the current game \u2014 make another game current first.", true);
            return;
        }

        const dest = destForId(id);
        if (!window.confirm("Remove " + id + "?\n\nThis deletes " + dest + " and cannot be undone."))
            return;

        setStatus("Removing " + id + "\u2026");
        cockpit.spawn(["bash", "-c", "rm -rf -- " + shQuote(dest)], { err: "message" })
            .then(() => refreshInstalledOnly())
            .catch((ex) => {
                setStatus("Failed to remove " + id + ": " + ((ex && (ex.message || ex.problem)) || String(ex)), true);
            });
    }

    // Re-scans the local disk and re-checks the known game_releases dests,
    // then re-renders only the Installed games section. Deliberately does
    // NOT touch `games` (the release list) or the Available to install
    // section — that only refreshes via the Refresh button / a download.
    async function refreshInstalledOnly() {
        setStatus("Refreshing installed games\u2026");
        try {
            const [scanResults, runContent] = await Promise.all([scanLocalGames(), readRunGameScript()]);
            runGameContent = runContent;
            localGameDirs = scanResults;

            if (Object.keys(games).length)
                installed = await checkInstalled(games);

            const knownDests = new Set(Object.values(games).map((e) => e.dest));
            applyLocalOnly(localGameDirs.filter((o) => !knownDests.has(o.dir)));
            computeCurrent();

            setStatus("");
        } catch (ex) {
            setStatus("Failed to refresh: " + ((ex && (ex.message || ex.problem)) || String(ex)), true);
        }
        renderInstalled();
    }

    // --- make current ---

    function makeCurrent(id) {
        if (busy) {
            setStatus("Please wait for the current operation to finish.", true);
            return;
        }
        if (id === current)
            return;

        const bp = binaryPathForId(id);
        if (!bp)
            return;

        setStatus("Setting " + id + " as the current game\u2026");

        const marker = "GDEOF";
        const fileContent = "#!/bin/bash\nexec " + shQuote(bp) + " \"$@\"\n";
        const script = "cat > " + shQuote(RUN_GAME_SCRIPT) + " <<'" + marker + "'\n" +
            fileContent + marker + "\n" +
            "chmod +x " + shQuote(RUN_GAME_SCRIPT);

        cockpit.spawn(["bash", "-c", script], { err: "message" })
            .then(() => loadAll())
            .catch((ex) => {
                setStatus("Failed to set current game: " + ((ex && (ex.message || ex.problem)) || String(ex)), true);
            });
    }

    // --- initial load ---

    async function loadAll() {
        games = {};
        installed = {};
        localGameDirs = [];
        localOnly = [];
        localBinaryPaths = {};
        current = null;
        refreshBtn.disabled = true;
        setStatus("Loading\u2026");

        // Phase 1: local disk scan + run_game.sh. No architecture check and
        // no release-list network call involved — a matching binary alone
        // means installed. Render right away.
        try {
            const [scanResults, runContent] = await Promise.all([scanLocalGames(), readRunGameScript()]);
            runGameContent = runContent;
            localGameDirs = scanResults;
            applyLocalOnly(localGameDirs);
            computeCurrent();
            setStatus("");
            render();
        } catch (ex) {
            setStatus("Failed to load: " + ((ex && (ex.message || ex.problem)) || String(ex)), true);
            refreshBtn.disabled = false;
            return;
        }

        // Phase 2: architecture + release list (network, capped at a 10s curl timeout).
        // Architecture only matters here, for picking the right download URL.
        setStatus("Checking for available downloads\u2026");
        try {
            const disabled = await isGameDownloadDisabled();

            if (disabled) {
                setStatus("Game downloads are disabled (DISABLE_GAME_DOWNLOAD=true in " + SETTINGS_ENV + ").");
            } else {
                const [arch, hasLink] = await Promise.all([detectArch(), hasNetworkLink()]);
                localArch = arch;

                if (!hasLink) {
                    setStatus("Not connected to the network, so only installed games are shown.");
                } else {
                    try {
                        const entries = await fetchReleases();
                        games = entries;
                        installed = Object.keys(entries).length ? await checkInstalled(entries) : {};

                        // Now that we know the real dest paths, drop any local-scan
                        // entry that's actually one of these so it isn't listed twice.
                        const knownDests = new Set(Object.values(entries).map((e) => e.dest));
                        applyLocalOnly(localGameDirs.filter((o) => !knownDests.has(o.dir)));
                        computeCurrent();

                        setStatus("");
                    } catch (ex) {
                        const msg = (ex && (ex.message || ex.problem)) || String(ex);
                        setStatus("Couldn't reach the release list, so only installed games are shown. (" + msg + ")", true);
                    }
                }
            }
        } catch (ex) {
            const msg = (ex && (ex.message || ex.problem)) || String(ex);
            setStatus("Couldn't reach the release list, so only installed games are shown. (" + msg + ")", true);
        }

        render();
        refreshBtn.disabled = false;
    }

    refreshBtn.addEventListener("click", loadAll);

    loadAll();
})();
