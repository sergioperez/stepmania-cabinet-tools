/*
 * Cockpit iwd module.
 *
 * Talks to iwd (net.connman.iwd) over the system D-Bus using cockpit's
 * D-Bus client. Passphrase entry for networks that are not yet "known"
 * to iwd is handled by spawning iwd-agent.py, a small helper that
 * registers a net.connman.iwd.Agent object and relays the passphrase
 * request back to this script over stdout/stdin.
 */
(function () {
    "use strict";

    const IWD_BUS_NAME = "net.connman.iwd";
    const AGENT_MANAGER_PATH = "/net/connman/iwd";
    const AGENT_HELPER = "/usr/share/cockpit/iwd/iwd-agent.py";

    const client = cockpit.dbus(IWD_BUS_NAME, { bus: "system", superuser: "try" });

    // iwd's D-Bus policy only allows root to call its methods. Cockpit's
    // "superuser: try" option above will route calls through Cockpit's
    // privileged bridge *once the session has administrative access
    // unlocked* (the padlock/shield in the Cockpit UI). Track that here
    // so we can point the user at the right control instead of just
    // surfacing a raw "Rejected send message" D-Bus error.
    const adminPermission = cockpit.permission({ admin: true });

    // In-memory model, rebuilt from GetManagedObjects + kept live via signals.
    let objects = {};          // path -> { iface: props }
    let devices = [];          // [{path, props}]
    let selectedDevicePath = null;
    let orderedNetworks = [];  // [{path, signal}] for the selected device's station
    let refreshTimer = null;
    let agentProc = null;      // currently running agent helper process, if any

    const el = (id) => document.getElementById(id);

    function setStatus(text) {
        el("status-bar").textContent = text || "";
    }

    function setError(text) {
        const bar = el("error-bar");
        if (!text) {
            bar.classList.add("hidden");
            bar.textContent = "";
        } else {
            bar.classList.remove("hidden");
            bar.textContent = text;
        }
    }

    function dbusErrorMessage(err) {
        if (!err)
            return "Unknown error";
        return err.problem || err.message || String(err);
    }

    // iwd's default D-Bus policy denies everyone except root. When that's
    // the cause of a failure, dbus-daemon reports it as a generic
    // "Rejected send message" access-denied error rather than anything
    // iwd-specific, so recognise it by text and translate it into
    // something actionable.
    function isPolicyRejection(err) {
        const msg = dbusErrorMessage(err);
        return /Rejected send message|AccessDenied|not authorized/i.test(msg);
    }

    function renderAdminBar() {
        el("admin-bar").classList.remove("hidden");
    }

    /* ---------------------------------------------------------------- */
    /* Object cache                                                      */
    /* ---------------------------------------------------------------- */

    // client.call() results preserve D-Bus variants as tagged objects
    // (e.g. { t: "s", v: "wlan0" }) instead of unwrapping them to plain
    // JS values, since a variant's static type isn't otherwise knowable.
    // GetManagedObjects()'s a{oa{sa{sv}}} is full of these at the
    // property-value level, so recursively unwrap before using it —
    // otherwise every property reads back as "[object Object]" and
    // strict equality checks against paths silently fail.
    function unwrapVariants(value) {
        if (Array.isArray(value))
            return value.map(unwrapVariants);
        if (value && typeof value === "object") {
            const keys = Object.keys(value);
            if (keys.length === 2 && keys.includes("t") && keys.includes("v"))
                return unwrapVariants(value.v);
            const out = {};
            for (const k of keys)
                out[k] = unwrapVariants(value[k]);
            return out;
        }
        return value;
    }

    function refresh() {
        return client.call("/", "org.freedesktop.DBus.ObjectManager", "GetManagedObjects", [])
            .then((result) => {
                objects = unwrapVariants(result[0]);
                rebuildModel();
                render();
            })
            .catch((err) => {
                if (isPolicyRejection(err)) {
                    setError("iwd only allows root to use its D-Bus API. " +
                              "Turn on administrative access (see banner above) and reload.");
                    renderAdminBar();
                } else {
                    setError("Could not talk to iwd: " + dbusErrorMessage(err) +
                              ". Is the iwd service running?");
                }
            });
    }

    function scheduleRefresh() {
        if (refreshTimer)
            return;
        refreshTimer = window.setTimeout(() => {
            refreshTimer = null;
            refresh();
        }, 150);
    }

    function ifacesAt(path, iface) {
        const o = objects[path];
        if (!o)
            return null;
        return o[iface] || null;
    }

    function findObjectsWithIface(iface) {
        const out = [];
        for (const path in objects) {
            if (objects[path][iface])
                out.push({ path: path, props: objects[path][iface] });
        }
        return out;
    }

    function rebuildModel() {
        devices = findObjectsWithIface("net.connman.iwd.Device")
            .filter((d) => d.props.Powered !== undefined); // wifi devices only

        if (!selectedDevicePath || !objects[selectedDevicePath]) {
            if (devices.length > 0)
                selectedDevicePath = devices[0].path;
            else
                selectedDevicePath = null;
        }
    }

    function currentStation() {
        if (!selectedDevicePath)
            return null;
        const props = ifacesAt(selectedDevicePath, "net.connman.iwd.Station");
        if (!props)
            return null;
        return { path: selectedDevicePath, props: props };
    }

    function currentDevice() {
        if (!selectedDevicePath)
            return null;
        const props = ifacesAt(selectedDevicePath, "net.connman.iwd.Device");
        if (!props)
            return null;
        return { path: selectedDevicePath, props: props };
    }

    function knownNetworkFor(networkProps) {
        const kn = networkProps.KnownNetwork;
        if (!kn || kn === "/")
            return null;
        const props = ifacesAt(kn, "net.connman.iwd.KnownNetwork");
        if (!props)
            return null;
        return { path: kn, props: props };
    }

    /* ---------------------------------------------------------------- */
    /* Rendering                                                         */
    /* ---------------------------------------------------------------- */

    function signalBars(signal100) {
        const dbm = signal100 / 100;
        if (dbm >= -50) return 4;
        if (dbm >= -60) return 3;
        if (dbm >= -70) return 2;
        return 1;
    }

    function signalIcon(bars) {
        const wrap = document.createElement("span");
        wrap.className = "signal-icon";
        for (let i = 1; i <= 4; i++) {
            const b = document.createElement("span");
            b.className = "bar" + (i <= bars ? " on" : "");
            wrap.appendChild(b);
        }
        return wrap;
    }

    function renderDeviceSelect() {
        const sel = el("device-select");
        sel.innerHTML = "";
        if (devices.length === 0) {
            const opt = document.createElement("option");
            opt.textContent = "No Wi-Fi adapter found";
            sel.appendChild(opt);
            sel.disabled = true;
            return;
        }
        sel.disabled = devices.length <= 1;
        devices.forEach((d) => {
            const opt = document.createElement("option");
            opt.value = d.path;
            opt.textContent = d.props.Name || d.path;
            if (d.path === selectedDevicePath)
                opt.selected = true;
            sel.appendChild(opt);
        });
    }

    function renderPower() {
        const dev = currentDevice();
        const toggle = el("power-toggle");
        toggle.checked = !!(dev && dev.props.Powered);
        toggle.disabled = !dev;
        el("scan-btn").disabled = !dev || !dev.props.Powered;
        el("hidden-btn").disabled = !dev || !dev.props.Powered;
    }

    function renderStatus() {
        const dev = currentDevice();
        const station = currentStation();
        if (!dev) {
            setStatus("No Wi-Fi hardware detected.");
            return;
        }
        if (!dev.props.Powered) {
            setStatus(dev.props.Name + " is turned off.");
            return;
        }
        if (!station) {
            setStatus(dev.props.Name + " is not in station mode.");
            return;
        }
        let text = "State: " + station.props.State;
        if (station.props.Scanning)
            text += " · scanning\u2026";
        if (station.props.ConnectedNetwork && station.props.ConnectedNetwork !== "/") {
            const np = ifacesAt(station.props.ConnectedNetwork, "net.connman.iwd.Network");
            if (np)
                text = "Connected to " + np.Name;
        }
        setStatus(text);
    }

    function renderKnownNetworks() {
        const list = el("known-list");
        list.innerHTML = "";
        const known = findObjectsWithIface("net.connman.iwd.KnownNetwork");
        known.sort((a, b) => (a.props.Name || "").localeCompare(b.props.Name || ""));

        known.forEach((k) => {
            const li = document.createElement("li");
            li.className = "network-item";

            const name = document.createElement("span");
            name.className = "net-name";
            name.textContent = k.props.Name;

            const meta = document.createElement("span");
            meta.className = "net-meta";
            meta.textContent = k.props.AutoConnect ? "auto-connect" : "manual";

            const actions = document.createElement("span");
            actions.className = "net-actions";

            const connectBtn = document.createElement("button");
            connectBtn.textContent = "Connect";
            connectBtn.onclick = (ev) => {
                ev.stopPropagation();
                connectToKnown(k);
            };

            const ipBtn = document.createElement("button");
            ipBtn.textContent = "IP settings";
            ipBtn.onclick = (ev) => {
                ev.stopPropagation();
                openIpSettings(k);
            };

            const forgetBtn = document.createElement("button");
            forgetBtn.textContent = "Forget";
            forgetBtn.className = "danger";
            forgetBtn.onclick = (ev) => {
                ev.stopPropagation();
                forgetNetwork(k);
            };

            actions.appendChild(connectBtn);
            actions.appendChild(ipBtn);
            actions.appendChild(forgetBtn);

            li.appendChild(name);
            li.appendChild(meta);
            li.appendChild(actions);
            list.appendChild(li);
        });
    }

    function renderAvailableNetworks() {
        const list = el("network-list");
        list.innerHTML = "";
        const station = currentStation();
        if (!station)
            return;

        // Build lookup of signal strength from the last GetOrderedNetworks() call.
        const signalByPath = {};
        orderedNetworks.forEach((n) => { signalByPath[n.path] = n.signal; });

        const networks = findObjectsWithIface("net.connman.iwd.Network")
            .filter((n) => n.props.Device === station.path);

        networks.sort((a, b) => {
            const sa = signalByPath[a.path] !== undefined ? signalByPath[a.path] : -100000;
            const sb = signalByPath[b.path] !== undefined ? signalByPath[b.path] : -100000;
            return sb - sa;
        });

        networks.forEach((n) => {
            const li = document.createElement("li");
            li.className = "network-item" + (n.props.Connected ? " connected" : "");

            const bars = signalByPath[n.path] !== undefined ? signalBars(signalByPath[n.path]) : 2;
            li.appendChild(signalIcon(bars));

            const name = document.createElement("span");
            name.className = "net-name";
            name.textContent = n.props.Name;
            li.appendChild(name);

            if (n.props.Type && n.props.Type !== "open") {
                const lock = document.createElement("span");
                lock.className = "lock-icon";
                lock.textContent = "\u{1F512}"; // lock emoji, keeps this file dependency-free
                li.appendChild(lock);
            }

            if (n.props.Connected) {
                const meta = document.createElement("span");
                meta.className = "net-meta";
                meta.textContent = "connected";
                li.appendChild(meta);
            }

            li.onclick = () => handleNetworkClick(n);
            list.appendChild(li);
        });
    }

    function render() {
        renderDeviceSelect();
        renderPower();
        renderStatus();
        renderKnownNetworks();
        renderAvailableNetworks();
    }

    /* ---------------------------------------------------------------- */
    /* Actions                                                           */
    /* ---------------------------------------------------------------- */

    function scan() {
        const station = currentStation();
        if (!station)
            return;
        setError(null);
        client.call(station.path, "net.connman.iwd.Station", "Scan", [])
            .catch((err) => setError("Scan failed: " + dbusErrorMessage(err)));
    }

    function setPower(on) {
        const dev = currentDevice();
        if (!dev)
            return;
        client.call(dev.path, "org.freedesktop.DBus.Properties", "Set",
                    ["net.connman.iwd.Device", "Powered", cockpit.variant("b", on)])
            .catch((err) => setError("Could not change power state: " + dbusErrorMessage(err)));
    }

    function refreshOrderedNetworks() {
        const station = currentStation();
        if (!station)
            return;
        client.call(station.path, "net.connman.iwd.Station", "GetOrderedNetworks", [])
            .then((result) => {
                orderedNetworks = result[0].map((entry) => ({ path: entry[0], signal: entry[1] }));
                renderAvailableNetworks();
            })
            .catch(() => { /* not fatal, list still renders unsorted */ });
    }

    function handleNetworkClick(network) {
        if (network.props.Connected)
            return;

        const known = knownNetworkFor(network.props);
        if (network.props.Type === "open" || known) {
            connectNetwork(network.path, network.props.Name);
            return;
        }

        // Secured, never-connected network: prompt for a passphrase and
        // hand it to iwd via our agent helper.
        promptPassphrase(network.props.Name).then((passphrase) => {
            if (passphrase !== null)
                connectNetworkWithAgent(network.path, network.props.Name, passphrase);
        });
    }

    function connectToKnown(known) {
        const network = findObjectsWithIface("net.connman.iwd.Network")
            .find((n) => n.props.KnownNetwork === known.path);
        if (network)
            connectNetwork(network.path, known.props.Name);
        else
            setError(known.props.Name + " is not currently in range.");
    }

    function connectNetwork(path, name) {
        setError(null);
        setStatus("Connecting to " + name + "\u2026");
        client.call(path, "net.connman.iwd.Network", "Connect", [])
            .then(() => refresh())
            .catch((err) => {
                setError("Could not connect to " + name + ": " + dbusErrorMessage(err));
                refresh();
            });
    }

    function forgetNetwork(known) {
        client.call(known.path, "net.connman.iwd.KnownNetwork", "Forget", [])
            .then(() => refresh())
            .catch((err) => setError("Could not forget network: " + dbusErrorMessage(err)));
    }

    function connectHidden(ssid) {
        const station = currentStation();
        if (!station)
            return Promise.reject(new Error("No station"));
        setStatus("Connecting to " + ssid + "\u2026");
        return client.call(station.path, "net.connman.iwd.Station", "ConnectHiddenNetwork", [ssid])
            .then(() => refresh());
    }

    /* ---------------------------------------------------------------- */
    /* IP configuration (static / DHCP, IPv4 and IPv6)                   */
    /*                                                                    */
    /* iwd has no D-Bus method for this: it's set purely by editing the   */
    /* network's own storage file under /var/lib/iwd, which iwd watches   */
    /* and reloads automatically. Per iwd.network(5):                     */
    /*   [IPv4] has no "Enabled" key - only Automatic (no section) vs.    */
    /*     Manual (Address + Gateway required, Netmask/DNS optional,      */
    /*     DNS is a SPACE-delimited address list).                        */
    /*   [IPv6] has a real Enabled=true/false key, plus optional static   */
    /*     Address (needs a /prefix, default 128), Gateway, and a         */
    /*     space-delimited DNS list.                                      */
    /* None of this does anything unless iwd itself is configured to      */
    /* manage IP addresses at all (main.conf [General]                    */
    /* EnableNetworkConfiguration=true).                                  */
    /* ---------------------------------------------------------------- */

    const IWD_STATE_DIR = "/var/lib/iwd";

    // iwd.network(5): the SSID appears verbatim in the filename if it's
    // only alphanumerics/space/underscore/minus; otherwise it's "=" plus
    // the lower-case hex encoding of the (UTF-8) name. The extension is
    // exactly the KnownNetwork's Type ("open"/"psk"/"8021x").
    function iwdStorageFileName(name, type) {
        const plain = /^[A-Za-z0-9 _-]+$/.test(name);
        let encoded;
        if (plain) {
            encoded = name;
        } else {
            const bytes = new TextEncoder().encode(name);
            encoded = "=" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
        }
        return IWD_STATE_DIR + "/" + encoded + "." + type;
    }

    // iwd.network(5) value escaping: backslash, \t, \r, \n are escaped;
    // a leading space is written as \s. Plain IP addresses never need
    // this, but it's cheap to be correct about it.
    function escapeSettingValue(v) {
        let out = String(v)
            .replace(/\\/g, "\\\\")
            .replace(/\t/g, "\\t")
            .replace(/\r/g, "\\r")
            .replace(/\n/g, "\\n");
        if (out.startsWith(" "))
            out = "\\s" + out.slice(1);
        return out;
    }

    function unescapeSettingValue(v) {
        let out = v;
        if (out.startsWith("\\s"))
            out = " " + out.slice(2);
        return out
            .replace(/\\n/g, "\n")
            .replace(/\\r/g, "\r")
            .replace(/\\t/g, "\t")
            .replace(/\\\\/g, "\\");
    }

    function findSection(lines, name) {
        const header = "[" + name + "]";
        let start = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim() === header) { start = i; break; }
        }
        if (start === -1)
            return null;
        let end = lines.length;
        for (let i = start + 1; i < lines.length; i++) {
            if (/^\s*\[/.test(lines[i])) { end = i; break; }
        }
        return { start: start, end: end };
    }

    function parseKeyValueLines(lines, start, end) {
        const out = {};
        for (let i = start; i < end; i++) {
            const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(lines[i]);
            if (m)
                out[m[1]] = unescapeSettingValue(m[2]);
        }
        return out;
    }

    // Replaces (or removes, or appends) named sections in one pass so
    // editing IPv4 and IPv6 together never invalidates the other's line
    // indices, and everything outside those two sections - including a
    // possibly-encrypted [Security] block - is left byte-for-byte alone.
    // `edits` is [{ name, newLines }], where newLines === null means
    // "make sure this section is absent" and an array means "this
    // section should contain exactly these lines" (header included).
    function replaceSections(lines, edits) {
        const byStart = {};
        edits.forEach((e) => {
            e.region = findSection(lines, e.name);
            if (e.region)
                byStart[e.region.start] = e;
        });

        const out = [];
        let i = 0;
        while (i < lines.length) {
            const edit = byStart[i];
            if (edit) {
                if (edit.newLines)
                    out.push(...edit.newLines);
                i = edit.region.end;
            } else {
                out.push(lines[i]);
                i++;
            }
        }

        edits.forEach((e) => {
            if (!e.region && e.newLines) {
                if (out.length && out[out.length - 1].trim() !== "")
                    out.push("");
                out.push(...e.newLines);
            }
        });

        return out;
    }

    function buildIPv4Lines(v4) {
        const lines = ["[IPv4]"];
        lines.push("Address=" + escapeSettingValue(v4.address));
        lines.push("Gateway=" + escapeSettingValue(v4.gateway));
        if (v4.netmask)
            lines.push("Netmask=" + escapeSettingValue(v4.netmask));
        if (v4.dns && v4.dns.length)
            lines.push("DNS=" + v4.dns.map(escapeSettingValue).join(" "));
        return lines;
    }

    function buildIPv6Lines(v6) {
        const lines = ["[IPv6]"];
        lines.push("Enabled=" + (v6.enabled ? "true" : "false"));
        if (v6.enabled && v6.mode === "static") {
            lines.push("Address=" + escapeSettingValue(v6.address));
            lines.push("Gateway=" + escapeSettingValue(v6.gateway));
            if (v6.dns && v6.dns.length)
                lines.push("DNS=" + v6.dns.map(escapeSettingValue).join(" "));
        }
        return lines;
    }

    // Reads the network's storage file and returns its current IPv4/IPv6
    // configuration plus the raw lines, so a save can patch just those
    // two sections and leave everything else untouched.
    function loadIpConfig(known) {
        const path = iwdStorageFileName(known.props.Name, known.props.Type);
        const file = cockpit.file(path, { superuser: "try" });
        return file.read().then((content) => {
            file.close();
            const lines = (content || "").split("\n");

            const v4section = findSection(lines, "IPv4");
            let ipv4;
            if (!v4section) {
                ipv4 = { mode: "dhcp", address: "", netmask: "", gateway: "", dns: [] };
            } else {
                const kv = parseKeyValueLines(lines, v4section.start + 1, v4section.end);
                ipv4 = {
                    mode: "static",
                    address: kv.Address || "",
                    netmask: kv.Netmask || "",
                    gateway: kv.Gateway || "",
                    dns: kv.DNS ? kv.DNS.split(/\s+/).filter(Boolean) : []
                };
            }

            const v6section = findSection(lines, "IPv6");
            let ipv6;
            if (!v6section) {
                ipv6 = { enabled: true, mode: "dhcp", address: "", gateway: "", dns: [] };
            } else {
                const kv = parseKeyValueLines(lines, v6section.start + 1, v6section.end);
                const enabled = kv.Enabled === undefined || /^(true|1)$/i.test(kv.Enabled);
                ipv6 = {
                    enabled: enabled,
                    mode: kv.Address ? "static" : "dhcp",
                    address: kv.Address || "",
                    gateway: kv.Gateway || "",
                    dns: kv.DNS ? kv.DNS.split(/\s+/).filter(Boolean) : []
                };
            }

            return { path: path, lines: lines, ipv4: ipv4, ipv6: ipv6 };
        }, (err) => {
            file.close();
            throw err;
        });
    }

    function saveIpConfig(state, form) {
        const v4Lines = form.ipv4.mode === "static" ? buildIPv4Lines(form.ipv4) : null;
        // Always write an explicit [IPv6] section: this is what lets a
        // network's IPv6 be genuinely turned off instead of silently
        // following whatever main.conf's global default happens to be.
        const v6Lines = buildIPv6Lines(form.ipv6);

        const lines = replaceSections(state.lines, [
            { name: "IPv4", newLines: v4Lines },
            { name: "IPv6", newLines: v6Lines }
        ]);

        const content = lines.join("\n");
        const file = cockpit.file(state.path, { superuser: "try" });
        return file.replace(content).then(
            () => { file.close(); },
            (err) => { file.close(); throw err; });
    }

    function isValidIPv4(v) {
        const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec((v || "").trim());
        if (!m)
            return false;
        return m.slice(1).every((octet) => Number(octet) >= 0 && Number(octet) <= 255);
    }

    // A solid, if not fully RFC-4291-exhaustive, IPv6 address matcher -
    // good enough to catch obvious typos in this form. Does not accept
    // IPv4-mapped ("::ffff:1.2.3.4") notation.
    const IPV6_RE = new RegExp(
        "^(" +
        "([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|" +
        "([0-9a-fA-F]{1,4}:){1,7}:|" +
        "([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|" +
        "([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|" +
        "([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|" +
        "([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|" +
        "([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|" +
        "[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|" +
        ":((:[0-9a-fA-F]{1,4}){1,7}|:)" +
        ")$");

    function isValidIPv6(v) {
        return IPV6_RE.test((v || "").trim());
    }

    function isValidIPv6WithOptionalPrefix(v) {
        const parts = (v || "").trim().split("/");
        if (parts.length > 2 || !isValidIPv6(parts[0]))
            return false;
        if (parts.length === 2) {
            if (!/^\d+$/.test(parts[1]))
                return false;
            const p = Number(parts[1]);
            if (p < 0 || p > 128)
                return false;
        }
        return true;
    }

    function reconnectKnownIfActive(known) {
        const station = currentStation();
        if (!station || !station.props.ConnectedNetwork || station.props.ConnectedNetwork === "/")
            return;
        const connected = ifacesAt(station.props.ConnectedNetwork, "net.connman.iwd.Network");
        if (!connected || connected.KnownNetwork !== known.path)
            return;
        if (!window.confirm("Reconnect to " + known.props.Name + " now to apply the new IP settings?"))
            return;
        client.call(station.path, "net.connman.iwd.Station", "Disconnect", [])
            .then(() => connectToKnown(known))
            .catch((err) => setError("Could not reconnect: " + dbusErrorMessage(err)));
    }

    function openIpSettings(known) {
        setError(null);

        if (adminPermission.allowed === false) {
            setError("IP settings require administrative access. Turn on administrative " +
                      "access (see banner above) to view or change them.");
            renderAdminBar();
            return;
        }

        loadIpConfig(known)
            .then((state) => showIpModal(known, state))
            .catch((err) => {
                if (err && err.problem === "access-denied") {
                    setError("IP settings require administrative access. Turn on administrative " +
                              "access (see banner above) to view or change them.");
                    renderAdminBar();
                } else {
                    setError("Could not read network configuration for " +
                              known.props.Name + ": " + dbusErrorMessage(err));
                }
            });
    }

    function showIpModal(known, state) {
        const modal = el("ipconfig-modal");
        const errBox = el("ipconfig-error");

        const v4StaticFields = el("ipv4-static-fields");
        const v4DhcpRadio = el("ipv4-mode-dhcp");
        const v4StaticRadio = el("ipv4-mode-static");

        const v6EnabledFields = el("ipv6-enabled-fields");
        const v6EnabledRadio = el("ipv6-enabled-true");
        const v6DisabledRadio = el("ipv6-enabled-false");
        const v6StaticFields = el("ipv6-static-fields");
        const v6DhcpRadio = el("ipv6-mode-dhcp");
        const v6StaticRadio = el("ipv6-mode-static");

        el("ipconfig-title").textContent = "IP settings \u2013 " + known.props.Name;
        errBox.classList.add("hidden");

        function applyV4Mode(mode) {
            v4StaticFields.classList.toggle("hidden", mode !== "static");
        }
        function applyV6Enabled(enabled) {
            v6EnabledFields.classList.toggle("hidden", !enabled);
        }
        function applyV6Mode(mode) {
            v6StaticFields.classList.toggle("hidden", mode !== "static");
        }

        v4DhcpRadio.checked = state.ipv4.mode !== "static";
        v4StaticRadio.checked = state.ipv4.mode === "static";
        applyV4Mode(state.ipv4.mode);
        el("ipv4-address").value = state.ipv4.address || "";
        el("ipv4-netmask").value = state.ipv4.netmask || "255.255.255.0";
        el("ipv4-gateway").value = state.ipv4.gateway || "";
        el("ipv4-dns").value = (state.ipv4.dns || []).join(" ");

        v6EnabledRadio.checked = state.ipv6.enabled !== false;
        v6DisabledRadio.checked = state.ipv6.enabled === false;
        applyV6Enabled(state.ipv6.enabled !== false);
        v6DhcpRadio.checked = state.ipv6.mode !== "static";
        v6StaticRadio.checked = state.ipv6.mode === "static";
        applyV6Mode(state.ipv6.mode);
        el("ipv6-address").value = state.ipv6.address || "";
        el("ipv6-gateway").value = state.ipv6.gateway || "";
        el("ipv6-dns").value = (state.ipv6.dns || []).join(" ");

        v4DhcpRadio.onchange = () => applyV4Mode("dhcp");
        v4StaticRadio.onchange = () => applyV4Mode("static");
        v6EnabledRadio.onchange = () => applyV6Enabled(true);
        v6DisabledRadio.onchange = () => applyV6Enabled(false);
        v6DhcpRadio.onchange = () => applyV6Mode("dhcp");
        v6StaticRadio.onchange = () => applyV6Mode("static");

        modal.classList.remove("hidden");

        function cleanup() {
            modal.classList.add("hidden");
            [v4DhcpRadio, v4StaticRadio, v6EnabledRadio, v6DisabledRadio, v6DhcpRadio, v6StaticRadio]
                .forEach((r) => { r.onchange = null; });
            el("ipconfig-save").onclick = null;
            el("ipconfig-cancel").onclick = null;
        }

        function fail(msg) {
            errBox.textContent = msg;
            errBox.classList.remove("hidden");
        }

        el("ipconfig-cancel").onclick = cleanup;

        el("ipconfig-save").onclick = () => {
            errBox.classList.add("hidden");

            const form = { ipv4: { mode: v4StaticRadio.checked ? "static" : "dhcp" },
                            ipv6: { enabled: v6EnabledRadio.checked } };

            if (form.ipv4.mode === "static") {
                form.ipv4.address = el("ipv4-address").value.trim();
                form.ipv4.netmask = el("ipv4-netmask").value.trim();
                form.ipv4.gateway = el("ipv4-gateway").value.trim();
                form.ipv4.dns = el("ipv4-dns").value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

                if (!isValidIPv4(form.ipv4.address))
                    return fail("IPv4 address is required and must be valid.");
                if (form.ipv4.netmask && !isValidIPv4(form.ipv4.netmask))
                    return fail("IPv4 netmask must be valid.");
                if (!isValidIPv4(form.ipv4.gateway))
                    return fail("IPv4 gateway is required and must be valid.");
                if (form.ipv4.dns.some((d) => !isValidIPv4(d)))
                    return fail("IPv4 DNS servers must be valid addresses.");
            }

            if (form.ipv6.enabled) {
                form.ipv6.mode = v6StaticRadio.checked ? "static" : "dhcp";
                if (form.ipv6.mode === "static") {
                    form.ipv6.address = el("ipv6-address").value.trim();
                    form.ipv6.gateway = el("ipv6-gateway").value.trim();
                    form.ipv6.dns = el("ipv6-dns").value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

                    if (!isValidIPv6WithOptionalPrefix(form.ipv6.address))
                        return fail("IPv6 address is required and must be valid (e.g. 2001:db8::50/64).");
                    if (!isValidIPv6(form.ipv6.gateway))
                        return fail("IPv6 gateway is required and must be valid.");
                    if (form.ipv6.dns.some((d) => !isValidIPv6(d)))
                        return fail("IPv6 DNS servers must be valid addresses.");
                }
            }

            saveIpConfig(state, form)
                .then(() => {
                    cleanup();
                    reconnectKnownIfActive(known);
                })
                .catch((err) => {
                    if (err && err.problem === "access-denied") {
                        fail("IP settings require administrative access. Turn on administrative " +
                             "access and try again.");
                        renderAdminBar();
                    } else {
                        fail("Could not save: " + dbusErrorMessage(err));
                    }
                });
        };
    }

    /* ---------------------------------------------------------------- */
    /* Agent-mediated connect (first-time passphrase entry)              */
    /* ---------------------------------------------------------------- */

    function connectNetworkWithAgent(path, name, passphrase) {
        setError(null);
        setStatus("Connecting to " + name + "\u2026");

        if (agentProc) {
            agentProc.close();
            agentProc = null;
        }

        let buffer = "";
        let sentPassphrase = false;
        let connectPromise = null;

        const proc = cockpit.spawn(["python3", AGENT_HELPER], {
            superuser: "try",
            err: "message"
        });
        agentProc = proc;

        proc.stream((data) => {
            buffer += data;
            let idx;
            while ((idx = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 1);
                handleAgentLine(line);
            }
        });

        function handleAgentLine(line) {
            if (line === "AGENT_READY") {
                connectPromise = client.call(path, "net.connman.iwd.Network", "Connect", []);
                connectPromise
                    .then(() => {
                        setError(null);
                        refresh();
                    })
                    .catch((err) => {
                        setError("Could not connect to " + name + ": " + dbusErrorMessage(err));
                        refresh();
                    })
                    .finally(() => {
                        if (agentProc === proc)
                            agentProc = null;
                        proc.close();
                    });
            } else if (line.indexOf("PASSPHRASE_NEEDED") === 0) {
                if (!sentPassphrase) {
                    sentPassphrase = true;
                    proc.input(passphrase + "\n", false);
                }
            } else if (line.indexOf("CANCELED") === 0) {
                setError("Connection was canceled.");
            }
            // USERNAME_PASSWORD_NEEDED / PRIVATE_KEY_PASSPHRASE_NEEDED are not
            // handled here: this UI only collects a single passphrase field.
            // Extend promptPassphrase()/the agent helper if you need 802.1x.
        }

        proc.catch((err) => {
            if (agentProc === proc)
                agentProc = null;
            setError("Wi-Fi agent helper failed: " + dbusErrorMessage(err));
        });
    }

    /* ---------------------------------------------------------------- */
    /* Modals                                                            */
    /* ---------------------------------------------------------------- */

    function promptPassphrase(networkName) {
        return new Promise((resolve) => {
            const modal = el("passphrase-modal");
            const input = el("passphrase-input");
            const showBox = el("passphrase-show");
            const errBox = el("passphrase-error");

            el("passphrase-title").textContent = "Connect to " + networkName;
            el("passphrase-desc").textContent = "Enter the network password.";
            input.value = "";
            input.type = "password";
            showBox.checked = false;
            errBox.classList.add("hidden");
            modal.classList.remove("hidden");
            input.focus();

            function cleanup(result) {
                modal.classList.add("hidden");
                el("passphrase-connect").onclick = null;
                el("passphrase-cancel").onclick = null;
                showBox.onchange = null;
                input.onkeydown = null;
                resolve(result);
            }

            showBox.onchange = () => { input.type = showBox.checked ? "text" : "password"; };

            el("passphrase-connect").onclick = () => {
                const val = input.value;
                if (val.length < 8) {
                    errBox.textContent = "Password must be at least 8 characters.";
                    errBox.classList.remove("hidden");
                    return;
                }
                cleanup(val);
            };
            el("passphrase-cancel").onclick = () => cleanup(null);
            input.onkeydown = (ev) => {
                if (ev.key === "Enter")
                    el("passphrase-connect").click();
                else if (ev.key === "Escape")
                    cleanup(null);
            };
        });
    }

    function promptHidden() {
        const modal = el("hidden-modal");
        const input = el("hidden-ssid-input");
        const errBox = el("hidden-error");

        input.value = "";
        errBox.classList.add("hidden");
        modal.classList.remove("hidden");
        input.focus();

        function cleanup() {
            modal.classList.add("hidden");
            el("hidden-connect").onclick = null;
            el("hidden-cancel").onclick = null;
            input.onkeydown = null;
        }

        el("hidden-connect").onclick = () => {
            const ssid = input.value.trim();
            if (!ssid) {
                errBox.textContent = "Enter a network name.";
                errBox.classList.remove("hidden");
                return;
            }
            cleanup();
            connectHidden(ssid).catch((err) => {
                setError("Could not connect: " + dbusErrorMessage(err) +
                          ". Hidden networks that require a password aren't supported by this dialog yet.");
            });
        };
        el("hidden-cancel").onclick = cleanup;
        input.onkeydown = (ev) => {
            if (ev.key === "Enter")
                el("hidden-connect").click();
            else if (ev.key === "Escape")
                cleanup();
        };
    }

    /* ---------------------------------------------------------------- */
    /* Wiring                                                            */
    /* ---------------------------------------------------------------- */

    function init() {
        el("device-select").onchange = (ev) => {
            selectedDevicePath = ev.target.value;
            orderedNetworks = [];
            render();
            refreshOrderedNetworks();
        };
        el("power-toggle").onchange = (ev) => setPower(ev.target.checked);
        el("scan-btn").onclick = scan;
        el("hidden-btn").onclick = promptHidden;

        adminPermission.addEventListener("changed", () => {
            if (adminPermission.allowed) {
                el("admin-bar").classList.add("hidden");
                refresh().then(refreshOrderedNetworks);
            }
        });
        el("admin-btn").onclick = () => {
            // Clicking Cockpit's own shield/lock button is the normal way
            // to unlock this; if a host page action is available, use it,
            // otherwise just point the user at it.
            if (typeof cockpit.jump === "function" && adminPermission.allowed === false)
                setError("Use the administrative access control in the Cockpit " +
                          "toolbar (top of the page) to unlock this, then reload.");
        };

        client.subscribe({ interface: "org.freedesktop.DBus.ObjectManager" }, scheduleRefresh);
        client.subscribe({ interface: "org.freedesktop.DBus.Properties", member: "PropertiesChanged" },
                          () => { scheduleRefresh(); refreshOrderedNetworks(); });

        refresh().then(refreshOrderedNetworks);

        // Networks appear/disappear as scans complete; also poll ordered
        // networks lightly so the sort order and signal bars stay fresh.
        window.setInterval(refreshOrderedNetworks, 5000);
    }

    document.addEventListener("DOMContentLoaded", init);
})();
