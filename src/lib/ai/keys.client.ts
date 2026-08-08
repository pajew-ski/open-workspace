'use client';

/**
 * Browser-side secret storage (localStorage).
 *
 * Keys stored here NEVER leave this browser: they are attached to
 * requests the browser itself makes directly to the inference endpoint
 * or MCP server. This is what makes the workspace usable entirely
 * without a backend — the trade-off (secret lives in localStorage,
 * readable by this origin) is stated openly in the UI.
 */

const PROVIDER_KEYS = 'ow.ai.provider-keys';
const MCP_AUTH = 'ow.ai.mcp-auth';

function readMap(storageKey: string): Record<string, string> {
    if (typeof window === 'undefined') return {};
    try {
        const raw = window.localStorage.getItem(storageKey);
        const parsed = raw ? JSON.parse(raw) : {};
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
        return {};
    }
}

function writeMap(storageKey: string, map: Record<string, string>): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(storageKey, JSON.stringify(map));
    } catch {
        // Storage full/blocked — the caller surfaces missing keys anyway.
    }
}

export function getBrowserProviderKey(providerId: string): string | undefined {
    return readMap(PROVIDER_KEYS)[providerId] || undefined;
}

export function setBrowserProviderKey(providerId: string, key: string): void {
    const map = readMap(PROVIDER_KEYS);
    if (key) {
        map[providerId] = key;
    } else {
        delete map[providerId];
    }
    writeMap(PROVIDER_KEYS, map);
}

export function deleteBrowserProviderKey(providerId: string): void {
    setBrowserProviderKey(providerId, '');
}

export function hasBrowserProviderKey(providerId: string): boolean {
    return Boolean(getBrowserProviderKey(providerId));
}

export function getBrowserMcpAuth(serverId: string): string | undefined {
    return readMap(MCP_AUTH)[serverId] || undefined;
}

export function setBrowserMcpAuth(serverId: string, value: string): void {
    const map = readMap(MCP_AUTH);
    if (value) {
        map[serverId] = value;
    } else {
        delete map[serverId];
    }
    writeMap(MCP_AUTH, map);
}
