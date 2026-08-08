/**
 * Best-effort detection of loopback/private/link-local targets.
 * Used for SSRF protection (server-side tool execution) and for routing
 * decisions (private endpoints must be called from the browser, because
 * a cloud-hosted backend can never reach the user's machine).
 *
 * Covers 127.*, 10.*, 172.16-31.*, 192.168.*, 169.254.*, 0.*, localhost,
 * ::1, IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
 */
export function isPrivateHostname(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();

    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === '::1' || host === '::') return true;

    // IPv4 (including IPv4-mapped IPv6 like ::ffff:127.0.0.1)
    const v4 = host.startsWith('::ffff:') ? host.slice(7) : host;
    const parts = v4.split('.');
    if (parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p))) {
        const [a, b] = parts.map(Number);
        if (a === 0) return true;                          // "this network" / 0.0.0.0
        if (a === 127) return true;                        // loopback
        if (a === 10) return true;                         // private
        if (a === 192 && b === 168) return true;           // private
        if (a === 172 && b >= 16 && b <= 31) return true;  // private
        if (a === 169 && b === 254) return true;           // link-local (cloud metadata!)
    }

    // IPv6 unique-local fc00::/7 and link-local fe80::/10
    if (/^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith('fe80:')) return true;

    return false;
}

/** Loopback only (the browser mixed-content exemption applies just to these). */
export function isLoopbackHostname(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === '::1') return true;
    const v4 = host.startsWith('::ffff:') ? host.slice(7) : host;
    const parts = v4.split('.');
    if (parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p))) {
        return Number(parts[0]) === 127;
    }
    return false;
}

export function isPrivateUrl(url: string): boolean {
    try {
        return isPrivateHostname(new URL(url).hostname);
    } catch {
        return false;
    }
}

/**
 * Would the current browser block this URL as mixed content?
 * (HTTPS page → plain-http target; loopback targets are exempt.)
 */
export function isMixedContentBlocked(targetUrl: string, pageProtocol: string): boolean {
    if (pageProtocol !== 'https:') return false;
    try {
        const url = new URL(targetUrl);
        if (url.protocol !== 'http:') return false;
        return !isLoopbackHostname(url.hostname);
    } catch {
        return false;
    }
}
