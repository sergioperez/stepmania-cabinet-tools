import { listEthernetInterfaces, getInterfaceState, applyInterfaceConfig, watchInterface } from './networkd-backend.js';

// `cockpit` is a global, provided by <script src="../base1/cockpit.js">
// in index.html. Note: cockpit.superuser (allowed/changed) belongs to a
// separate "superuser.js" helper library some Cockpit projects pull in
// additionally - it is NOT guaranteed to exist from cockpit.js alone.
// cockpit.permission() is the API that's actually part of the core
// cockpit.js this plugin loads, so that's what we use here. .allowed is
// `null` until the permission check resolves asynchronously - treated
// as "not admin yet" (button stays disabled) until it settles one way
// or the other via the "changed" event.
const adminPermission = cockpit.permission({ admin: true });

function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'text') node.textContent = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
        else node.setAttribute(k, v);
    }
    for (const child of children) node.appendChild(child);
    return node;
}

/**
 * Build the enabled/method/address/DNS form for one address family.
 * DNS only applies (and only shows) when this family is set to Static -
 * "Automatic" means everything, DNS included, comes from DHCP/RA with no
 * override.
 */
function buildFamilySection(ifaceName, familyLabel, familyKey, addressPlaceholder, prefixPlaceholder, dnsPlaceholder) {
    const section = el('fieldset', { class: 'family-section' });
    section.appendChild(el('legend', { text: familyLabel }));

    const enabledRow = el('label', { class: 'iface-row' });
    const enabledCheckbox = el('input', { type: 'checkbox' });
    enabledRow.appendChild(enabledCheckbox);
    enabledRow.appendChild(document.createTextNode(` ${familyLabel} enabled`));
    section.appendChild(enabledRow);

    const methodRow = el('div', { class: 'iface-row' });
    const dhcpRadio = el('input', { type: 'radio', name: `${ifaceName}-${familyKey}-method`, value: 'dhcp' });
    const staticRadio = el('input', { type: 'radio', name: `${ifaceName}-${familyKey}-method`, value: 'static' });
    methodRow.appendChild(el('label', {}, [dhcpRadio, document.createTextNode(' Automatic')]));
    methodRow.appendChild(el('label', {}, [staticRadio, document.createTextNode(' Static')]));
    section.appendChild(methodRow);

    const staticFields = el('div', { class: 'iface-static-fields' });
    const addressInput = el('input', { type: 'text', placeholder: addressPlaceholder });
    const prefixInput = el('input', { type: 'text', placeholder: prefixPlaceholder });
    const gatewayInput = el('input', { type: 'text', placeholder: 'gateway (optional)' });
    const dnsInput = el('input', { type: 'text', placeholder: dnsPlaceholder });
    staticFields.appendChild(el('label', { text: 'Address' }));
    staticFields.appendChild(addressInput);
    staticFields.appendChild(el('label', { text: 'Prefix length' }));
    staticFields.appendChild(prefixInput);
    staticFields.appendChild(el('label', { text: 'Gateway' }));
    staticFields.appendChild(gatewayInput);
    staticFields.appendChild(el('label', { text: 'DNS servers (optional, space-separated)' }));
    staticFields.appendChild(dnsInput);
    section.appendChild(staticFields);

    function updateVisibility() {
        const disabled = !enabledCheckbox.checked;
        dhcpRadio.disabled = disabled;
        staticRadio.disabled = disabled;
        methodRow.style.opacity = disabled ? 0.5 : 1;
        staticFields.style.display = (enabledCheckbox.checked && staticRadio.checked) ? '' : 'none';
    }

    enabledCheckbox.addEventListener('input', updateVisibility);
    staticRadio.addEventListener('input', updateVisibility);
    dhcpRadio.addEventListener('input', updateVisibility);

    return {
        node: section,
        updateVisibility,
        setValue(familyConfig) {
            enabledCheckbox.checked = familyConfig.enabled;
            dhcpRadio.checked = familyConfig.method === 'dhcp';
            staticRadio.checked = familyConfig.method === 'static';
            addressInput.value = familyConfig.address || '';
            prefixInput.value = familyConfig.prefix || '';
            gatewayInput.value = familyConfig.gateway || '';
            dnsInput.value = (familyConfig.dns || []).join(' ');
            updateVisibility();
        },
        getValue() {
            const isStatic = staticRadio.checked;
            const value = {
                enabled: enabledCheckbox.checked,
                method: isStatic ? 'static' : 'dhcp',
                address: addressInput.value,
                prefix: prefixInput.value,
                gateway: gatewayInput.value,
            };
            if (isStatic && dnsInput.value.trim()) {
                value.dns = dnsInput.value.trim().split(/\s+/);
            }
            return value;
        },
        inputs: [enabledCheckbox, dhcpRadio, staticRadio, addressInput, prefixInput, gatewayInput, dnsInput],
        isDirty(familyConfig) {
            const currentDns = (familyConfig.dns || []).join(' ');
            return (
                enabledCheckbox.checked !== familyConfig.enabled ||
                (staticRadio.checked ? 'static' : 'dhcp') !== familyConfig.method ||
                (enabledCheckbox.checked && staticRadio.checked && (
                    addressInput.value !== (familyConfig.address || '') ||
                    prefixInput.value !== (familyConfig.prefix || '') ||
                    gatewayInput.value !== (familyConfig.gateway || '') ||
                    dnsInput.value.trim() !== currentDns
                ))
            );
        },
    };
}

function describeError(err) {
    // Cockpit's spawn/file/dbus rejections don't reliably follow the
    // standard Error shape (sometimes a plain string, sometimes
    // {problem: ...} with no .message, occasionally near-empty) - probe
    // several shapes rather than assuming err.message exists, so any
    // error display never ends up blank.
    if (err && err.message) return err.message;
    if (err && err.problem) return err.problem;
    if (typeof err === 'string' && err) return err;
    if (err) { try { return JSON.stringify(err); } catch { /* fall through */ } }
    return 'Unknown error - see browser console for details';
}

function buildInterfacePanel(iface) {
    const card = el('div', { class: 'iface-card' });
    card.appendChild(el('h3', { text: iface.name }));

    const statusLine = el('p', { class: 'iface-status' });
    card.appendChild(statusLine);
    const addressLine = el('p', { class: 'iface-address' });
    card.appendChild(addressLine);

    const errorBox = el('div', { class: 'iface-error', style: 'display:none' });
    card.appendChild(errorBox);

    const form = el('form', { class: 'iface-form' });
    card.appendChild(form);

    const v4 = buildFamilySection(iface.name, 'IPv4', 'ipv4', '192.168.1.50', '24', '192.168.1.1');
    const v6 = buildFamilySection(iface.name, 'IPv6', 'ipv6', 'fd00::50', '64', 'fd00::1');
    form.appendChild(v4.node);
    form.appendChild(v6.node);

    const applyButton = el('button', { type: 'submit', text: 'Apply', disabled: 'disabled' });
    form.appendChild(applyButton);
    const adminNote = el('p', { class: 'admin-note', text: 'Administrative access is required to change network settings.', style: 'display:none' });
    form.appendChild(adminNote);

    let current = null;
    let stopWatching = null;

    function updateApplyButtonState() {
        const isAdmin = adminPermission.allowed === true; // null (unresolved) or false both mean "not yet allowed"
        adminNote.style.display = isAdmin ? 'none' : '';
        if (!isAdmin) {
            applyButton.disabled = true;
            return;
        }
        if (!current) return;
        applyButton.disabled = !(v4.isDirty(current.ipv4) || v6.isDirty(current.ipv6));
    }
    const checkDirty = updateApplyButtonState;
    [...v4.inputs, ...v6.inputs].forEach(input => input.addEventListener('input', checkDirty));

    // Re-evaluate once the permission check resolves, and again if the
    // user toggles Cockpit's "Administrative access" mid-session.
    adminPermission.addEventListener('changed', updateApplyButtonState);

    /**
     * Collapse networkd's three separate state properties into one plain
     * up/down read. "Operational" state is the one that actually reflects
     * usable IP connectivity - carrier only tells you a cable is plugged
     * in, and admin state only tells you whether networkd is managing the
     * link at all, neither of which is "is it up" on its own.
     */
    function deriveStatus({ carrierState, operationalState, administrativeState }) {
        if (administrativeState === 'unmanaged') {
            return { label: 'Not managed', className: 'status-down' };
        }
        if (carrierState === 'off' || carrierState === 'no-carrier') {
            return { label: 'No cable connected', className: 'status-down' };
        }
        if (operationalState === 'routable' || operationalState === 'degraded') {
            return { label: 'Up', className: 'status-up' };
        }
        return { label: 'Down', className: 'status-down' };
    }

    function renderLiveStatus(live) {
        const status = deriveStatus(live);
        statusLine.textContent = status.label;
        statusLine.className = `iface-status ${status.className}`;
    }

    async function refresh() {
        current = await getInterfaceState(iface.name);
        v4.setValue(current.ipv4);
        v6.setValue(current.ipv6);
        addressLine.textContent =
            `Current: IPv4 ${current.liveAddresses.v4 || 'none'} | IPv6 ${current.liveAddresses.v6 || 'none'}`;
        renderLiveStatus(current);
        updateApplyButtonState();

        if (stopWatching) stopWatching();
        try {
            stopWatching = await watchInterface(iface.name, (update) => {
                renderLiveStatus({ ...current, ...update });
            });
        } catch (err) {
            console.error('Failed to watch', iface.name, err);
        }
    }

    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        errorBox.style.display = 'none';
        applyButton.disabled = true;
        applyButton.textContent = 'Applying...';
        try {
            await applyInterfaceConfig(iface.name, {
                ipv4: v4.getValue(),
                ipv6: v6.getValue(),
            });
            await refresh();
        } catch (err) {
            console.error('applyInterfaceConfig failed for', iface.name, err);
            errorBox.textContent = 'Failed to apply changes: ' + describeError(err);
            errorBox.style.display = '';
        } finally {
            applyButton.textContent = 'Apply';
        }
    });

    refresh().catch(err => {
        console.error('Initial refresh failed for', iface.name, err);
        errorBox.textContent = 'Failed to load interface state: ' + describeError(err);
        errorBox.style.display = '';
    });
    return card;
}

async function main() {
    const root = document.getElementById('app');
    root.textContent = 'Loading...';

    let interfaces;
    try {
        interfaces = await listEthernetInterfaces();
    } catch (err) {
        root.textContent = 'Failed to list Ethernet interfaces: ' + (err.message || String(err));
        return;
    }

    root.textContent = '';
    if (interfaces.length === 0) {
        root.appendChild(el('p', { text: 'No Ethernet interfaces found.' }));
        return;
    }
    for (const iface of interfaces) {
        root.appendChild(buildInterfacePanel(iface));
    }
}

document.addEventListener('DOMContentLoaded', main);
