/* Cockpit "Input" plugin — ITGMania input drivers and device order */

(function () {
    "use strict";

    const PREFS = "/home/stepmania/.itgmania/Save/Preferences.ini";
    const SERVICE = "game";
    const DRIVERS = ["X11", "LinuxJoystick", "LinuxEvent"];

    const state = {
        drivers: [],        // enabled drivers, in the order they are written to the file
        mode: "auto",       // "auto" | "manual"
        devices: [],        // { id, name, path, links[] }
        selection: [],      // device ids, in the chosen order
        busy: false,
    };

    const el = {
        drivers: document.getElementById("drivers"),
        mode: document.getElementById("mode"),
        hint: document.getElementById("devices-hint"),
        clear: document.getElementById("clear"),
        devices: document.getElementById("devices"),
        apply: document.getElementById("apply"),
        refresh: document.getElementById("refresh"),
        status: document.getElementById("status"),
    };

    /* ---------- Preferences.ini ---------- */

    function iniValue(content, key) {
        const m = content.match(new RegExp("^[ \\t]*" + key + "[ \\t]*=(.*)$", "mi"));
        return m ? m[1].trim() : null;
    }

    function sedEscape(value) {
        return value.replace(/[\\&]/g, "\\$&");
    }

    function splitList(value) {
        return (value || "").split(",").map(s => s.trim()).filter(s => s !== "");
    }

    /* ---------- udev ---------- */

    function parseUdevDb(text) {
        const records = [];
        let cur = null;
        for (const raw of text.split("\n")) {
            const line = raw.replace(/\r$/, "");
            if (line === "") {
                if (cur) records.push(cur);
                cur = null;
                continue;
            }
            const tag = line[0];
            const value = line.slice(3);
            if (tag === "P") {
                cur = { devpath: value, links: [], props: {} };
            } else if (!cur) {
                continue;
            } else if (tag === "S") {
                cur.links.push("/dev/" + value);
            } else if (tag === "E") {
                const eq = value.indexOf("=");
                if (eq > 0)
                    cur.props[value.slice(0, eq)] = value.slice(eq + 1);
            }
        }
        if (cur) records.push(cur);
        return records;
    }

    // /dev/input/event3 and /dev/input/js0 are separate udev nodes belonging to the
    // same physical device; group them by their common inputN parent.
    function parentPath(devpath) {
        return devpath.replace(/\/[^/]+$/, "");
    }

    function pickPath(links) {
        const byPath = links.filter(l => l.startsWith("/dev/input/by-path/"));
        return byPath.find(l => /-joystick$/.test(l) && !/-event-/.test(l)) ||
               byPath.find(l => /-event-joystick$/.test(l)) ||
               byPath.find(l => /-event-kbd$/.test(l)) ||
               byPath.find(l => /-event/.test(l)) ||
               byPath[0] || null;
    }

    function deviceName(props, path) {
        const name = props.ID_USB_MODEL || props.ID_MODEL || props.NAME || "";
        return name.replace(/^"|"$/g, "") || path.split("/").pop();
    }

    function listDevices() {
        return cockpit.spawn(["udevadm", "info", "--export-db"], { err: "message" })
                .then(output => {
                    const groups = new Map();
                    for (const rec of parseUdevDb(output)) {
                        const wanted = rec.props.ID_INPUT_JOYSTICK === "1" ||
                                       rec.props.ID_INPUT_KEYBOARD === "1";
                        if (!wanted)
                            continue;
                        if (!rec.links.some(l => l.startsWith("/dev/input/by-path/")))
                            continue;
                        const key = parentPath(rec.devpath);
                        const group = groups.get(key) || { id: key, links: [], props: {} };
                        group.links = group.links.concat(rec.links);
                        group.props = Object.assign({}, rec.props, group.props);
                        groups.set(key, group);
                    }

                    const devices = [];
                    for (const group of groups.values()) {
                        const path = pickPath(group.links);
                        if (!path)
                            continue;
                        devices.push({
                            id: group.id,
                            name: deviceName(group.props, path),
                            path: path,
                            links: group.links.filter(l => l.startsWith("/dev/input/by-path/")),
                        });
                    }
                    devices.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
                    return devices;
                });
    }

    /* ---------- loading ---------- */

    function load() {
        setStatus("");
        return Promise.all([cockpit.file(PREFS).read(), listDevices().catch(() => [])])
                .then(([content, devices]) => {
                    state.devices = devices;

                    if (content === null) {
                        state.drivers = [];
                        state.mode = "auto";
                        state.selection = [];
                        setStatus(PREFS + " was not found. Applying will not create it.", "error");
                        render();
                        return;
                    }

                    const known = new Map(DRIVERS.map(d => [d.toLowerCase(), d]));
                    state.drivers = splitList(iniValue(content, "InputDrivers"))
                            .map(d => known.get(d.toLowerCase()))
                            .filter(d => d !== undefined);

                    const order = splitList(iniValue(content, "InputDeviceOrder"));
                    state.mode = order.length > 0 ? "manual" : "auto";
                    state.selection = order
                            .map(p => devices.find(d => d.links.indexOf(p) >= 0 || d.path === p))
                            .filter(d => d !== undefined)
                            .map(d => d.id);

                    if (state.mode === "manual" && order.length !== state.selection.length)
                        setStatus("Some devices listed in InputDeviceOrder are not connected right now.");

                    applyModeRules();
                    render();
                });
    }

    /* ---------- rules ---------- */

    function applyModeRules() {
        if (state.mode === "manual")
            state.drivers = state.drivers.filter(d => d !== "LinuxEvent");
        else
            state.selection = [];
    }

    function toggleDriver(driver) {
        const at = state.drivers.indexOf(driver);
        if (at >= 0)
            state.drivers.splice(at, 1);
        else
            state.drivers.push(driver);
        render();
    }

    function pickDevice(id) {
        const at = state.selection.indexOf(id);
        if (at >= 0)
            state.selection.splice(at, 1);   // picking a ranked device again drops it, the rest renumber
        else
            state.selection.push(id);        // otherwise it takes the next number
        render();
    }

    function clearSelection() {
        state.selection = [];
        render();
    }

    function setMode(mode) {
        if (state.mode === mode)
            return;
        state.mode = mode;
        applyModeRules();
        render();
    }

    /* ---------- rendering ---------- */

    function render() {
        el.drivers.textContent = "";
        for (const driver of DRIVERS) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "opt";
            button.textContent = driver;
            const blocked = driver === "LinuxEvent" && state.mode === "manual";
            button.disabled = blocked || state.busy;
            if (blocked)
                button.title = "LinuxEvent cannot be used with a manual input order";
            if (state.drivers.indexOf(driver) >= 0)
                button.classList.add("selected");
            button.addEventListener("click", () => toggleDriver(driver));
            el.drivers.appendChild(button);
        }

        for (const button of el.mode.querySelectorAll(".opt")) {
            button.classList.toggle("selected", button.dataset.mode === state.mode);
            button.disabled = state.busy;
        }

        const manual = state.mode === "manual";
        el.hint.textContent = manual
            ? "Click devices in the order ITGMania should read them. Click a numbered device again to drop it."
            : "Detected devices. ITGMania orders them itself in Auto — switch to Manual to set the order.";
        el.devices.textContent = "";
        if (state.devices.length === 0) {
            const empty = document.createElement("p");
            empty.className = "empty";
            empty.textContent = "No joystick or keyboard devices found.";
            el.devices.appendChild(empty);
        }
        for (const device of state.devices) {
            const rank = state.selection.indexOf(device.id);
            const button = document.createElement("button");
            button.type = "button";
            button.className = "device" + (rank >= 0 ? " selected" : "");
            button.disabled = state.busy || !manual;

            const name = document.createElement("span");
            name.className = "name";
            if (rank >= 0) {
                const badge = document.createElement("span");
                badge.className = "rank";
                badge.textContent = "(" + (rank + 1) + ")";
                name.appendChild(badge);
            }
            name.appendChild(document.createTextNode(device.name));

            const path = document.createElement("span");
            path.className = "path";
            path.textContent = device.path;

            button.appendChild(name);
            button.appendChild(path);
            button.addEventListener("click", () => pickDevice(device.id));
            el.devices.appendChild(button);
        }

        el.clear.disabled = state.busy || !manual || state.selection.length === 0;
        el.apply.disabled = state.busy;
        el.refresh.disabled = state.busy;
    }

    function setStatus(text, kind) {
        el.status.hidden = !text;
        el.status.textContent = text || "";
        el.status.className = "status" + (kind ? " " + kind : "");
    }

    function appendStatus(text, kind) {
        const previous = el.status.textContent;
        setStatus(previous ? previous + "\n" + text : text, kind);
    }

    /* ---------- apply ---------- */

    function driverList() {
        return DRIVERS.filter(d => state.drivers.indexOf(d) >= 0)
                .sort((a, b) => state.drivers.indexOf(a) - state.drivers.indexOf(b))
                .join(",");
    }

    function deviceOrder() {
        if (state.mode !== "manual")
            return "";
        return state.selection
                .map(id => (state.devices.find(d => d.id === id) || {}).path)
                .filter(p => p)
                .join(",");
    }

    function systemctl(verb) {
        return cockpit.spawn(["sudo", "systemctl", verb, SERVICE], { err: "message" });
    }

    function writePrefs(drivers, order) {
        // sed replaces the two lines in place; no in-browser ini editing.
        const sub = (key, value) =>
            "s|^[[:space:]]*" + key + "[[:space:]]*=.*|" + key + "=" + sedEscape(value) + "|";
        return cockpit.spawn(["sed", "-i",
                              "-e", sub("InputDrivers", drivers),
                              "-e", sub("InputDeviceOrder", order),
                              PREFS],
                             { err: "message" });
    }

    function apply() {
        state.busy = true;
        render();

        const drivers = driverList();
        const order = deviceOrder();
        let failed = false;

        setStatus("Stopping " + SERVICE + "…");
        systemctl("stop")
                .then(() => {
                    appendStatus("Writing " + PREFS + "…");
                    return writePrefs(drivers, order);
                })
                .then(() => {
                    appendStatus("InputDrivers=" + drivers);
                    appendStatus("InputDeviceOrder=" + order);
                })
                .catch(error => {
                    failed = true;
                    appendStatus("Failed: " + (error.message || String(error)));
                })
                .finally(() => {
                    // Always bring the game back, even if the edit failed.
                    appendStatus("Starting " + SERVICE + "…");
                    return systemctl("start")
                            .then(() => {
                                appendStatus(failed ? SERVICE + " restarted."
                                                    : "Configuration applied.",
                                             failed ? "error" : "ok");
                            })
                            .catch(error => {
                                appendStatus("Could not start " + SERVICE + ": " +
                                             (error.message || String(error)), "error");
                            })
                            .finally(() => {
                                state.busy = false;
                                render();
                            });
                });
    }

    /* ---------- wiring ---------- */

    for (const button of el.mode.querySelectorAll(".opt"))
        button.addEventListener("click", () => setMode(button.dataset.mode));

    el.clear.addEventListener("click", clearSelection);
    el.apply.addEventListener("click", apply);
    el.refresh.addEventListener("click", () => {
        state.busy = true;
        render();
        load().catch(error => setStatus("Failed to read configuration: " +
                                        (error.message || String(error)), "error"))
                .finally(() => { state.busy = false; render(); });
    });

    load().catch(error => setStatus("Failed to read configuration: " +
                                    (error.message || String(error)), "error"));
})();
