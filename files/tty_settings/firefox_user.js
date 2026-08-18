// DevTools (kiosk profile only; other profiles/users are unaffected)
user_pref("devtools.policy.disabled", true);
user_pref("devtools.chrome.enabled", false);
user_pref("devtools.debugger.remote-enabled", false);

// Safe mode / crash recovery
user_pref("toolkit.startup.max_resumed_crashes", -1);

// Session restore
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.sessionstore.max_resumed_crashes", -1);

// Startup / homepage
user_pref("browser.startup.page", 1);
user_pref("browser.startup.homepage", "https://localhost:9090");
user_pref("startup.homepage_override_url", "");
user_pref("browser.startup.homepage_override.mstone", "ignore");

// New tab page
user_pref("browser.newtabpage.enabled", false);

// Bookmarks toolbar
user_pref("browser.toolbars.bookmarks.visibility", "never");

// Screenshots
user_pref("extensions.screenshots.disabled", true);

// Pocket
user_pref("extensions.pocket.enabled", false);

// Form history
user_pref("browser.formfill.enable", false);

// App update
user_pref("app.update.auto", false);
user_pref("app.update.enabled", false);

// Default browser check
user_pref("browser.shell.checkDefaultBrowser", false);
