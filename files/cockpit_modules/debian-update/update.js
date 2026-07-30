"use strict";

const output_el = document.getElementById("output");
const system_info_el = document.getElementById("system-info");
const update_status_el = document.getElementById("update-status");
const release_card_el = document.getElementById("release-card");
const release_info_el = document.getElementById("release-info");
const reboot_card_el = document.getElementById("reboot-card");

const btn_check = document.getElementById("btn-check");
const btn_update = document.getElementById("btn-update");
const btn_release_upgrade = document.getElementById("btn-release-upgrade");
const btn_reboot = document.getElementById("btn-reboot");

const keptback_row_el = document.getElementById("keptback-row");
const keptback_text_el = document.getElementById("keptback-text");
const btn_install_keptback = document.getElementById("btn-install-keptback");
let keptback_packages = [];

// Options passed to dpkg during unattended upgrades so a conffile prompt
// never blocks the run: keep the currently installed config unless the
// package has no local changes to it.
const DPKG_UNATTENDED_OPTS = [
    "-o", "Dpkg::Options::=--force-confdef",
    "-o", "Dpkg::Options::=--force-confold"
];

let current_codename = null;
let current_suite = null;

// Tracks whether the logged-in Cockpit user is allowed to become
// superuser at all. null means the check hasn't resolved yet.
const admin_permission = cockpit.permission({ admin: true });

const NO_ADMIN_MESSAGE = "You need to have administrative access to perform this operation";

function require_admin() {
    if (admin_permission.allowed === false) {
        set_status(NO_ADMIN_MESSAGE, true);
        return false;
    }
    return true;
}

function log(text) {
    output_el.textContent += text;
    output_el.scrollTop = output_el.scrollHeight;
}

function log_line(text) {
    log(text + "\n");
}

function clear_log() {
    output_el.textContent = "";
}

function set_status(text, is_error) {
    update_status_el.textContent = text || "";
    update_status_el.classList.toggle("error", !!is_error);
}

function set_busy(busy) {
    btn_check.disabled = busy;
    btn_update.disabled = busy || !current_codename;
    btn_release_upgrade.disabled = busy;
    btn_reboot.disabled = busy;
    btn_install_keptback.disabled = busy;
}

function show_keptback(pkgs) {
    keptback_packages = pkgs;
    if (!pkgs.length) {
        keptback_row_el.classList.add("hidden");
        return;
    }
    keptback_text_el.textContent = pkgs.length + " package" + (pkgs.length === 1 ? "" : "s") +
        " kept back (upgrading would need to install or remove other packages): " + pkgs.join(", ");
    keptback_row_el.classList.remove("hidden");
}

// Runs argv as root, streaming stdout+stderr into the terminal box.
// Returns a promise resolving to the full captured output on exit code 0.
function run_step(argv, extra_env) {
    log_line("$ " + argv.join(" "));
    const opts = {
        superuser: "require",
        err: "out",
        pty: true
    };
    if (extra_env)
        opts.environ = extra_env;

    let captured = "";
    const proc = cockpit.spawn(argv, opts);
    proc.stream(data => { captured += data; log(data); });
    return proc.then(() => { log_line(""); return captured; },
        ex => { log_line(""); throw ex; });
}

// Parses apt's "The following packages have been kept back:" block, which
// apt-get upgrade prints (and skips) instead of pulling in the extra
// installs/removals a package would need.
function parse_kept_back(text) {
    const m = text.match(/The following packages have been kept back:\n((?:\s+\S.*\n)+)/);
    if (!m)
        return [];
    return m[1].trim().split(/\s+/).filter(Boolean);
}

function parse_os_release(text) {
    const info = {};
    text.split("\n").forEach(line => {
        const m = line.match(/^([A-Za-z_]+)=(.*)$/);
        if (m)
            info[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    });
    return info;
}

function detect_suite(policy_text, codename) {
    const escaped = codename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("a=([\\w.-]+),n=" + escaped + "(?:,|$)", "m");
    const m = policy_text.match(re);
    return m ? m[1] : null;
}

function suite_badge(suite) {
    let cls = "badge";
    if (suite === "stable")
        cls += " stable";
    else if (suite === "oldstable")
        cls += " oldstable";
    return "<span class=\"" + cls + "\">" + (suite || "unknown") + "</span>";
}

function render_system_info(os_release, suite) {
    const pretty = os_release.PRETTY_NAME || ("Debian " + (os_release.VERSION_ID || ""));
    system_info_el.innerHTML =
        "<div><span class=\"label\">System</span>" + pretty + "</div>" +
        "<div><span class=\"label\">Codename</span>" + (current_codename || "unknown") + "</div>" +
        "<div><span class=\"label\">Release status</span>" + suite_badge(suite) + "</div>";
}

function load_system_info() {
    return cockpit.spawn(["cat", "/etc/os-release"], { err: "message" })
        .then(text => {
            const os_release = parse_os_release(text);
            current_codename = os_release.VERSION_CODENAME || null;

            if (!current_codename) {
                system_info_el.textContent = "Could not determine the Debian codename from /etc/os-release.";
                return;
            }

            // apt-cache policy works without root, but only reports release
            // metadata for sources that have been fetched at least once.
            return cockpit.spawn(["apt-cache", "policy"], { err: "message" })
                .then(policy_text => {
                    current_suite = detect_suite(policy_text, current_codename);
                    render_system_info(os_release, current_suite);
                    update_release_card();
                    btn_update.disabled = false;
                })
                .catch(() => {
                    render_system_info(os_release, null);
                    system_info_el.innerHTML += "<div class=\"status-line\">Run \"Check for updates\" once to detect release status.</div>";
                    btn_update.disabled = false;
                });
        })
        .catch(ex => {
            system_info_el.textContent = "Could not read /etc/os-release: " + ex;
        });
}

function fetch_new_stable_codename() {
    return cockpit.spawn(["curl", "--max-time", "10", "-fsSL",
        "https://deb.debian.org/debian/dists/stable/Release"], { err: "message" })
        .then(text => {
            const m = text.match(/^Codename:\s*(\S+)/m);
            return m ? m[1] : null;
        });
}

function update_release_card() {
    if (current_suite !== "oldstable") {
        release_card_el.classList.add("hidden");
        return;
    }

    release_info_el.textContent = "This system is on \"" + current_codename +
        "\", which is now oldstable. Checking the new stable release…";
    release_card_el.classList.remove("hidden");

    fetch_new_stable_codename().then(new_codename => {
        if (!new_codename) {
            release_info_el.textContent = "This system is on \"" + current_codename +
                "\" (oldstable), but the current stable codename could not be determined right now.";
            btn_release_upgrade.disabled = true;
            return;
        }
        btn_release_upgrade.dataset.target = new_codename;
        release_info_el.textContent = "This system is on \"" + current_codename +
            "\" (oldstable). Debian \"" + new_codename + "\" is now stable. " +
            "Upgrading will repoint apt sources from \"" + current_codename + "\" to \"" +
            new_codename + "\", run a full upgrade, and recommend a reboot.";
    }).catch(ex => {
        release_info_el.textContent = "This system is on \"" + current_codename +
            "\" (oldstable), but the current stable codename could not be determined (" + ex + ").";
        btn_release_upgrade.disabled = true;
    });
}

function check_reboot_required() {
    return cockpit.spawn(["test", "-e", "/var/run/reboot-required"], { err: "ignore" })
        .then(() => true)
        .catch(() => false);
}

function maybe_show_reboot_card() {
    return check_reboot_required().then(needed => {
        reboot_card_el.classList.toggle("hidden", !needed);
    });
}

function count_upgradable(list_text) {
    // First line of "apt list --upgradable" is a "Listing..." notice.
    return list_text.split("\n").filter(l => l && !l.startsWith("Listing...")).length;
}

btn_check.addEventListener("click", () => {
    if (!require_admin())
        return;

    set_busy(true);
    clear_log();
    set_status("Checking for updates…");
    show_keptback([]);

    run_step(["apt-get", "update"])
        .then(() => cockpit.spawn(["apt", "list", "--upgradable"], { err: "message" }))
        .then(list_text => {
            const n = count_upgradable(list_text);
            set_status(n > 0 ? (n + " package" + (n === 1 ? "" : "s") + " can be upgraded.")
                              : "System is up to date.");
            btn_update.disabled = n === 0;
            return cockpit.spawn(["apt-cache", "policy"], { err: "message" });
        })
        .then(policy_text => {
            if (current_codename)
                current_suite = detect_suite(policy_text, current_codename);
            return cockpit.spawn(["cat", "/etc/os-release"], { err: "message" });
        })
        .then(text => {
            render_system_info(parse_os_release(text), current_suite);
            update_release_card();
        })
        .catch(ex => set_status("Check failed: " + ex, true))
        .finally(() => set_busy(false));
});

btn_update.addEventListener("click", () => {
    if (!require_admin())
        return;

    set_busy(true);
    clear_log();
    set_status("Updating…");
    show_keptback([]);

    run_step(["apt-get", "update"])
        .then(() => run_step(["apt-get", "-y"].concat(DPKG_UNATTENDED_OPTS, ["full-upgrade"]),
            ["DEBIAN_FRONTEND=noninteractive"]))
        .then(upgrade_output => run_step(["apt-get", "-y", "autoremove"],
            ["DEBIAN_FRONTEND=noninteractive"]).then(() => upgrade_output))
        .then(upgrade_output => {
            set_status("Update complete.");
            show_keptback(parse_kept_back(upgrade_output));
            return maybe_show_reboot_card();
        })
        .catch(ex => set_status("Update failed: " + ex, true))
        .finally(() => set_busy(false));
});

btn_install_keptback.addEventListener("click", () => {
    if (!keptback_packages.length)
        return;
    if (!require_admin())
        return;

    set_busy(true);
    set_status("Installing kept-back package" + (keptback_packages.length === 1 ? "" : "s") + "…");

    run_step(["apt-get", "-y"].concat(DPKG_UNATTENDED_OPTS, ["install"], keptback_packages),
        ["DEBIAN_FRONTEND=noninteractive"])
        .then(() => {
            set_status("Installed: " + keptback_packages.join(", "));
            show_keptback([]);
            return maybe_show_reboot_card();
        })
        .catch(ex => set_status("Install failed: " + ex, true))
        .finally(() => set_busy(false));
});

btn_release_upgrade.addEventListener("click", () => {
    if (!require_admin())
        return;

    const target = btn_release_upgrade.dataset.target;
    if (!target)
        return;

    if (!window.confirm("Upgrade this system from \"" + current_codename + "\" to \"" + target +
        "\"? This rewrites apt sources, runs a full upgrade, and should be followed by a reboot. Continue?"))
        return;

    set_busy(true);
    clear_log();
    set_status("Upgrading to " + target + "…");

    const stamp = Math.floor(Date.now() / 1000);
    const src = current_codename;
    // Whole-word replacement so "trixie-security" becomes "forky-security",
    // not "forkyxie-security" or similar.
    const sed_expr = "s/\\b" + src + "\\b/" + target + "/g";

    run_step(["bash", "-c",
        "set -e; " +
        "for f in /etc/apt/sources.list $(ls /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources 2>/dev/null); do " +
        "  [ -f \"$f\" ] || continue; " +
        "  cp -a \"$f\" \"$f.bak-" + stamp + "\"; " +
        "  sed -i '" + sed_expr + "' \"$f\"; " +
        "done"])
        .then(() => run_step(["apt-get", "update"]))
        .then(() => run_step(["apt-get", "-y"].concat(DPKG_UNATTENDED_OPTS, ["full-upgrade"]),
            ["DEBIAN_FRONTEND=noninteractive"]))
        .then(() => run_step(["apt-get", "-y", "autoremove"], ["DEBIAN_FRONTEND=noninteractive"]))
        .then(() => {
            current_codename = target;
            set_status("Upgrade to " + target + " complete. Please reboot.");
            reboot_card_el.classList.remove("hidden");
            return load_system_info();
        })
        .catch(ex => set_status("Release upgrade failed: " + ex + ". Sources were backed up with a .bak-" +
            stamp + " suffix before any changes.", true))
        .finally(() => set_busy(false));
});

btn_reboot.addEventListener("click", () => {
    if (!require_admin())
        return;
    if (!window.confirm("Reboot this system now?"))
        return;
    cockpit.spawn(["reboot"], { superuser: "require" })
        .catch(ex => set_status("Reboot failed: " + ex, true));
});

set_busy(false);
load_system_info();
maybe_show_reboot_card();
