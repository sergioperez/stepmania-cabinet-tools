/*
 * Builds/parses the plugin's dedicated .network file.
 *
 *   config = {
 *     ipv4: { enabled: bool, method: 'dhcp' | 'static',
 *             address?, prefix?, gateway?, dns?: string[] },
 *     ipv6: { enabled: bool, method: 'dhcp' | 'static',
 *             address?, prefix?, gateway?, dns?: string[] },
 *   }
 *
 * DNS lives on each family's config, not as its own section - it's only
 * meaningful (and only shown in the UI) when that family is Static.
 * "Automatic" means exactly that: whatever DHCP/RA hands over, no DNS
 * override at all, nothing to configure. This mirrors ifupdown's own
 * `dns-nameservers` convention of living inside the per-family stanza,
 * rather than the earlier separate-section design.
 *
 * "enabled: false" for a family means: no DHCP client for it and no
 * static address. For IPv6 specifically it also means no link-local
 * address and no accepted Router Advertisements (via
 * LinkLocalAddressing=/IPv6AcceptRA=) - the closest networkd equivalent
 * to "disable IPv6" as a concept.
 *
 * IPv4 link-local (169.254.0.0/16, aka APIPA) is always suppressed
 * regardless of whether IPv4 itself is enabled - see the comment above
 * linkLocalDirective() for why: a known systemd-networkd surprise is
 * that it stays active as a *second* address alongside a working
 * DHCP/static IPv4 address unless explicitly turned off.
 *
 * DNS specifics:
 *   - IPv4 static + dns: DHCPv4 isn't running in static mode, so there's
 *     nothing else competing to provide DNS - just DNS=<servers>.
 *   - IPv6 static + dns: Router Advertisements may still be accepted
 *     (for routing) even with a static address, and could bring their
 *     own RDNSS-advertised DNS servers alongside ours. We add
 *     [IPv6AcceptRA] UseDNS=no so the static list is authoritative
 *     rather than merged unpredictably.
 *   - There is deliberately no equivalent "static IPv4 + still get DNS
 *     via DHCP" option: systemd-networkd has UseAddress= to suppress a
 *     DHCPv6-offered address while keeping other DHCPv6 options, but no
 *     DHCPv4 equivalent (confirmed against `man systemd.network` -
 *     UseAddress= only exists under [DHCPv6]). Running DHCP=ipv4
 *     alongside a static Address= would apply *both* addresses, which
 *     is the same "two addresses" problem this plugin exists to avoid.
 */

export function networkFilePath(name) {
    return `/etc/systemd/network/10-cockpit-ethernet-${name}.network`;
}

function dhcpDirective(ipv4, ipv6) {
    const wantV4 = ipv4.enabled && ipv4.method === 'dhcp';
    const wantV6 = ipv6.enabled && ipv6.method === 'dhcp';
    if (wantV4 && wantV6) return 'yes';
    if (wantV4) return 'ipv4';
    if (wantV6) return 'ipv6';
    return 'no';
}

function linkLocalDirective(ipv6) {
    return ipv6.enabled ? 'ipv6' : 'no';
}

export function buildNetworkFile(name, config) {
    const { ipv4, ipv6 } = config;

    const networkLines = [
        `DHCP=${dhcpDirective(ipv4, ipv6)}`,
        `LinkLocalAddressing=${linkLocalDirective(ipv6)}`,
    ];
    if (!ipv6.enabled) {
        networkLines.push('IPv6AcceptRA=no');
    }
    if (ipv4.enabled && ipv4.method === 'static' && ipv4.address) {
        networkLines.push(`Address=${ipv4.address}/${ipv4.prefix}`);
        if (ipv4.gateway) networkLines.push(`Gateway=${ipv4.gateway}`);
    }
    if (ipv6.enabled && ipv6.method === 'static' && ipv6.address) {
        networkLines.push(`Address=${ipv6.address}/${ipv6.prefix}`);
        if (ipv6.gateway) networkLines.push(`Gateway=${ipv6.gateway}`);
    }

    const dnsServers = [];
    if (ipv4.enabled && ipv4.method === 'static' && ipv4.dns && ipv4.dns.length) {
        dnsServers.push(...ipv4.dns);
    }
    if (ipv6.enabled && ipv6.method === 'static' && ipv6.dns && ipv6.dns.length) {
        dnsServers.push(...ipv6.dns);
    }
    if (dnsServers.length > 0) {
        networkLines.push(`DNS=${dnsServers.join(' ')}`);
    }

    const acceptRaLines = [];
    if (ipv6.enabled && ipv6.method === 'static' && ipv6.dns && ipv6.dns.length) {
        // Make our static list authoritative over any RDNSS servers a
        // still-accepted Router Advertisement might also offer.
        acceptRaLines.push('UseDNS=no');
    }

    const lines = [
        '# Managed by the cockpit-ethernet plugin - do not hand-edit,',
        '# changes will be overwritten the next time it applies a change.',
        '',
        '[Match]',
        `Name=${name}`,
        '',
        '[Network]',
        ...networkLines,
    ];
    if (acceptRaLines.length > 0) {
        lines.push('', '[IPv6AcceptRA]', ...acceptRaLines);
    }

    lines.push('');
    return lines.join('\n');
}

function isIPv6(addr) {
    return addr.includes(':');
}

export function parseNetworkFile(text) {
    const empty = { enabled: false, method: 'dhcp' };
    if (!text) return { ipv4: { ...empty }, ipv6: { ...empty } };

    const dhcpMatch = text.match(/^DHCP=(\S+)\s*$/m);
    const dhcpValue = dhcpMatch ? dhcpMatch[1] : 'no';
    const linkLocalMatch = text.match(/^LinkLocalAddressing=(\S+)\s*$/m);
    const linkLocal = linkLocalMatch ? linkLocalMatch[1] : 'yes'; // default is both

    const addressLines = [...text.matchAll(/^Address=(\S+)\/(\d+)\s*$/gm)];
    const gatewayLines = [...text.matchAll(/^Gateway=(\S+)\s*$/gm)];
    const dnsMatch = text.match(/^DNS=(.+)\s*$/m);
    const allDnsServers = dnsMatch ? dnsMatch[1].trim().split(/\s+/) : [];
    const v4DnsServers = allDnsServers.filter(s => !isIPv6(s));
    const v6DnsServers = allDnsServers.filter(isIPv6);

    const v4Addr = addressLines.find(m => !isIPv6(m[1]));
    const v6Addr = addressLines.find(m => isIPv6(m[1]));
    const v4Gw = gatewayLines.find(m => !isIPv6(m[1]));
    const v6Gw = gatewayLines.find(m => isIPv6(m[1]));

    const ipv4 = {
        enabled: !!v4Addr || dhcpValue === 'yes' || dhcpValue === 'ipv4',
        method: v4Addr ? 'static' : 'dhcp',
    };
    if (v4Addr) {
        ipv4.address = v4Addr[1];
        ipv4.prefix = v4Addr[2];
        if (v4Gw) ipv4.gateway = v4Gw[1];
        if (v4DnsServers.length) ipv4.dns = v4DnsServers;
    }

    const ipv6 = {
        enabled: linkLocal === 'yes' || linkLocal === 'ipv6' || !!v6Addr || dhcpValue === 'yes' || dhcpValue === 'ipv6',
        method: v6Addr ? 'static' : 'dhcp',
    };
    if (v6Addr) {
        ipv6.address = v6Addr[1];
        ipv6.prefix = v6Addr[2];
        if (v6Gw) ipv6.gateway = v6Gw[1];
        if (v6DnsServers.length) ipv6.dns = v6DnsServers;
    }

    return { ipv4, ipv6 };
}
