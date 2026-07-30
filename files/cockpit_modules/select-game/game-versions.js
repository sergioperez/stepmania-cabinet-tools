(function () {
    "use strict";

    var GAME_DIR = "/home/stepmania/game";
    var RUN_SCRIPT = "/home/stepmania/run_game.sh";
    var BINARY_NAMES = ["itgmania", "deadsync", "outfox"];

    // Matches an absolute path ending in one of the known binary names,
    // optionally wrapped in single or double quotes. Case-insensitive so it
    // matches "OutFox", "ITGMania", etc. Group 1 is the quote char (or empty
    // string), group 2 is the path itself.
    var PATH_RE = new RegExp(
        "([\"']?)(\\/(?:[^\\s\"'<>|]+\\/)*(?:" + BINARY_NAMES.join("|") + "))\\1",
        "i"
    );

    var buttonsEl = document.getElementById("buttons");
    var statusEl = document.getElementById("status");

    function setStatus(msg, isError) {
        statusEl.textContent = msg || "";
        statusEl.className = "status" + (isError ? " error" : "");
    }

    function versionLabelFromPath(path) {
        var parts = path.split("/");
        var binary = parts.pop() || "";
        var version = parts.pop() || path;
        return { version: version, binary: binary };
    }

    // Scan /home/stepmania/game/<version>/<binary> for known binaries.
    function findAvailableVersions() {
        var args = [
            "find", GAME_DIR,
            "-mindepth", "2", "-maxdepth", "2", "-type", "f",
            "(",
            "-iname", "itgmania", "-o",
            "-iname", "deadsync", "-o",
            "-iname", "outfox",
            ")"
        ];

        return cockpit.spawn(args, { err: "message" })
            .then(function (output) {
                return output.split("\n")
                    .map(function (l) { return l.trim(); })
                    .filter(function (l) { return l !== ""; })
                    .map(function (path) {
                        var info = versionLabelFromPath(path);
                        return { version: info.version, binary: info.binary, path: path };
                    });
            })
            .catch(function (err) {
                // Most likely GAME_DIR doesn't exist yet - treat as "no versions found"
                // rather than a fatal error.
                console.warn("Could not scan " + GAME_DIR + ":", err);
                return [];
            });
    }

    // Read run_game.sh and pull out the binary path it currently points at.
    function readCurrent() {
        var file = cockpit.file(RUN_SCRIPT);
        return file.read()
            .then(function (content) {
                file.close();
                content = content || "";
                var m = content.match(PATH_RE);
                return { content: content, currentPath: m ? m[2] : null };
            })
            .catch(function (err) {
                file.close();
                throw err;
            });
    }

    // Overwrite the binary path inside run_game.sh with newPath, leaving the
    // rest of the script untouched.
    function switchToVersion(v) {
        var file = cockpit.file(RUN_SCRIPT);
        file.read()
            .then(function (content) {
                content = content || "";
                if (!PATH_RE.test(content)) {
                    throw new Error(
                        "Could not find an existing game binary path in " + RUN_SCRIPT +
                        " to replace. Please check the file manually."
                    );
                }
                var newContent = content.replace(PATH_RE, function (match, quote) {
                    return quote + v.path + quote;
                });
                return file.replace(newContent);
            })
            .then(function () {
                file.close();
                refresh();
            })
            .catch(function (err) {
                file.close();
                setStatus("Failed to switch version: " + (err.message || err), true);
            });
    }

    function samePath(a, b) {
        return !!a && !!b && a.toLowerCase() === b.toLowerCase();
    }

    function render(versions, currentPath) {
        buttonsEl.innerHTML = "";

        var allVersions = versions.slice();
        var currentMatched = versions.some(function (v) { return samePath(v.path, currentPath); });

        // Currently running binary wasn't found under GAME_DIR - add a button
        // for it too, so the user can see/select what's actually running.
        if (currentPath && !currentMatched) {
            var info = versionLabelFromPath(currentPath);
            allVersions.push({
                version: info.version,
                binary: info.binary,
                path: currentPath,
                extra: true
            });
        }

        if (allVersions.length === 0) {
            var none = document.createElement("p");
            none.textContent = "No game versions found under " + GAME_DIR + ".";
            buttonsEl.appendChild(none);
            return;
        }

        allVersions.forEach(function (v) {
            var isCurrent = samePath(v.path, currentPath);

            var btn = document.createElement("button");
            btn.className = "version-btn" + (isCurrent ? " current" : "");
            btn.title = v.path;

            var name = document.createElement("span");
            name.className = "version-name";
            name.textContent = v.version;
            btn.appendChild(name);

            var sub = document.createElement("span");
            sub.className = "version-binary";
            sub.textContent = v.binary + (v.extra ? " \u2014 not under " + GAME_DIR : "");
            btn.appendChild(sub);

            if (isCurrent) {
                var badge = document.createElement("span");
                badge.className = "badge";
                badge.textContent = "current";
                btn.appendChild(badge);
            }

            btn.addEventListener("click", function () {
                if (isCurrent)
                    return;
                switchToVersion(v);
            });

            buttonsEl.appendChild(btn);
        });
    }

    function refresh() {
        return Promise.all([findAvailableVersions(), readCurrent()])
            .then(function (results) {
                var versions = results[0];
                var current = results[1];
                setStatus("", false);
                render(versions, current.currentPath);
            })
            .catch(function (err) {
                setStatus("Error loading game versions: " + (err.message || err), true);
            });
    }

    refresh();
}());
