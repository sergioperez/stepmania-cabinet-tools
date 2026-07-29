import { networkFilePath, buildNetworkFile, parseNetworkFile } from './network-file.js';

// `cockpit` is a global, provided by <script src="../base1/cockpit.js">
// in index.html.

const NETWORKD_BUS = 'org.freedesktop.network1';
const MANAGER_PATH = '/org/freedesktop/network1';
const MANAGER_IFACE = 'org.freedesktop.network1.Manager';
const LINK_IFACE = 'org.freedesktop.network1.Link';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';

/*
 * IMPORTANT: cockpit.dbus() does NOT automatically use Cockpit's
 * privileged bridge just because the page-level "Administrative access"
 * toggle is on - each dbus() connection needs its own `superuser` option,
 * same as cockpit.spawn()/cockpit.file(). Without it, D-Bus calls run as
 * your normal unprivileged session, and any polkit-guarded method
 * (Reload, ReconfigureLink) fails with "Interactive authentication
 * required" instead of prompting - this was the bug behind that error.
 *
 * We keep two clients: a "try" one for reads (works even if the user
 * never got admin access, e.g. for a read-only view) and a "require" one
 * only opened for the actual write/apply path, matching the pattern
 * cockpit.spawn/cockpit.file already use elsewhere in this plugin.
 */
function readClient() {
    return cockpit.dbus(NETWORKD_BUS, { bus: 'system', superuser: 'try' });
}
function privilegedClient() {
    return cockpit.dbus(NETWORKD_BUS, { bus: 'system', superuser: 'require' });
}

export async function listEthernetInterfaces() {
    const script = `
        for d in /sys/class/net/*/; do
            iface=$(basename "$d")
            [ "$iface" = "lo" ] && continue
            [ -e "$d/wireless" ] && continue
            type=$(cat "$d/type" 2>/dev/null)
            [ "$type" != "1" ] && continue
            devtype=""
            [ -f "$d/uevent" ] && devtype=$(grep -oP '(?<=^DEVTYPE=).*' "$d/uevent")
            case "$devtype" in
                bridge|bond|tun|tap|vlan|veth|wwan) continue ;;
            esac
            echo "$iface"
        done
    `;
    const output = await cockpit.script(script, [], { superuser: 'try' });
    return output.trim().split('\n').filter(Boolean).map(name => ({ name }));
}

async function getLink(client, name) {
    const [ifindex, path] = await client.call(MANAGER_PATH, MANAGER_IFACE, 'GetLinkByName', [name]);
    return { ifindex, path };
}

async function getLinkProperties(client, path) {
    const [props] = await client.call(path, PROPS_IFACE, 'GetAll', [LINK_IFACE]);
    const unwrap = v => (v && typeof v === 'object' && 'v' in v ? v.v : v);
    return {
        operationalState: unwrap(props.OperationalState),
        administrativeState: unwrap(props.AdministrativeState),
        carrierState: unwrap(props.CarrierState),
    };
}

/** Live IPv4 *and* IPv6 addresses via `ip`, still not cleanly available as a plain D-Bus property. */
async function getLiveAddresses(name) {
    const result = { v4: null, v6: null };
    try {
        const out4 = await cockpit.spawn(['ip', '-4', '-o', 'addr', 'show', name], { superuser: 'try' });
        const m4 = out4.match(/inet (\S+)/);
        if (m4) result.v4 = m4[1];
    } catch { /* no v4 address */ }
    try {
        const out6 = await cockpit.spawn(['ip', '-6', '-o', 'addr', 'show', name, 'scope', 'global'], { superuser: 'try' });
        const m6 = out6.match(/inet6 (\S+)/);
        if (m6) result.v6 = m6[1];
    } catch { /* no v6 global address */ }
    return result;
}

export async function getInterfaceState(name) {
    const client = readClient();
    const path = networkFilePath(name);

    let fileText = null;
    try {
        fileText = await cockpit.file(path, { superuser: 'try' }).read();
    } catch { /* file doesn't exist yet */ }

    const { ipv4, ipv6 } = parseNetworkFile(fileText);
    const managedByPlugin = fileText !== null;

    let live = { operationalState: 'unknown', administrativeState: 'unknown', carrierState: 'unknown' };
    try {
        const { path: linkPath } = await getLink(client, name);
        live = await getLinkProperties(client, linkPath);
    } catch (err) {
        console.error('Failed to read link state for', name, err);
    }

    const liveAddresses = await getLiveAddresses(name);
    client.close();
    return { managedByPlugin, ipv4, ipv6, ...live, liveAddresses };
}

export async function watchInterface(name, callback) {
    const client = readClient();
    const { path } = await getLink(client, name);
    const subscription = client.subscribe(
        { path, interface: PROPS_IFACE, member: 'PropertiesChanged' },
        (_path, _iface, _signal, args) => {
            const [, changed] = args;
            const unwrap = v => (v && typeof v === 'object' && 'v' in v ? v.v : v);
            const update = {};
            if ('OperationalState' in changed) update.operationalState = unwrap(changed.OperationalState);
            if ('AdministrativeState' in changed) update.administrativeState = unwrap(changed.AdministrativeState);
            if ('CarrierState' in changed) update.carrierState = unwrap(changed.CarrierState);
            callback(update);
        }
    );
    return () => { subscription.remove(); client.close(); };
}

/**
 * config: { ipv4: {enabled, method, address?, prefix?, gateway?, dns?: string[]},
 *           ipv6: {enabled, method, address?, prefix?, gateway?, dns?: string[]} }
 *
 * dns is only meaningful (and only sent by the UI) when that family's
 * method is 'static' - "Automatic" means no DNS override at all.
 *
 * If both families end up disabled, the plugin's .network file is
 * removed entirely (interface reverts to unmanaged) and the link is
 * brought down - mirroring the ifupdown version's "disabled" behavior.
 * Otherwise the file is written/updated and the link stays/comes up.
 */
export async function applyInterfaceConfig(name, config) {
    const client = privilegedClient(); // <-- the fix: superuser: 'require' on the dbus() call itself
    const path = networkFilePath(name);
    const file = cockpit.file(path, { superuser: 'require' });

    const bothDisabled = !config.ipv4.enabled && !config.ipv6.enabled;

    try {
        if (bothDisabled) {
            await file.replace(null);
        } else {
            await file.replace(buildNetworkFile(name, config));
        }
    } finally {
        file.close();
    }

    await client.call(MANAGER_PATH, MANAGER_IFACE, 'Reload', []);

    if (bothDisabled) {
        await cockpit.spawn(['ip', 'link', 'set', name, 'down'], { superuser: 'require' });
    } else {
        const { ifindex } = await getLink(client, name);
        await cockpit.spawn(['ip', 'link', 'set', name, 'up'], { superuser: 'require' });
        await client.call(MANAGER_PATH, MANAGER_IFACE, 'ReconfigureLink', [ifindex]);
    }

    client.close();
}
