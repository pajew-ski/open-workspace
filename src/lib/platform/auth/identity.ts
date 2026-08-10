/**
 * Identität der Runtimes `server` und `ha-addon` (SPEC §5.2, M12).
 *
 * Vier Betriebsarten, alle vier ehrlich benannt (`OW_AUTH_MODE`):
 *
 *  - `single-user`  — kein Anmeldeverfahren. Der Workspace gehört einem
 *                     Nutzer, so wie er heute läuft. Default.
 *  - `ha-ingress`   — Home Assistant hat den Nutzer bereits angemeldet und
 *                     schickt ihn in den Ingress-Headern mit.
 *  - `proxy-header` — ein vorgelagerter Authentifizierungs-Proxy
 *                     (oauth2-proxy in deploy/server/docker-compose.yml)
 *                     führt den OIDC-Anmeldefluss und setzt die Header.
 *  - `oidc-bearer`  — der Client bringt selbst ein Token mit; es wird gegen
 *                     die JWKS des Issuers geprüft (auth/oidc.ts).
 *
 * Was diese Schicht NICHT tut: Zugriffe erlauben oder verbieten. Die
 * Durchsetzung pro Graph ist M13 (§17); bis dahin steht davor entweder der
 * Proxy (Runtime `server`) oder Home Assistant (Runtime `ha-addon`). Die
 * Identität wird gelesen und angezeigt — nicht als Rechteprüfung
 * ausgegeben, die es noch nicht gibt.
 */

import { DEFAULT_USER_ID } from '@/lib/graph/iri';
import type { Identity } from '../runtime/types';
import { OidcError, verifyOidcToken } from './oidc';

export type IdentityMode = 'single-user' | 'ha-ingress' | 'proxy-header' | 'oidc-bearer';

export interface ResolvedIdentity extends Identity {
    mode: IdentityMode;
    /** true, wenn die Identität aus einer geprüften Quelle stammt. */
    authenticated: boolean;
    displayName?: string;
    /** Grund, wenn keine Identität ermittelt werden konnte. */
    reason?: string;
}

export interface IdentityEnv {
    /** Prozess-Umgebungen bringen beliebige weitere Schlüssel mit. */
    [key: string]: string | undefined;
    OW_AUTH_MODE?: string;
    OW_AUTH_USER_HEADER?: string;
    OW_AUTH_NAME_HEADER?: string;
    OW_AUTH_GROUPS_HEADER?: string;
    OW_OIDC_ISSUER?: string;
    OW_OIDC_AUDIENCE?: string;
    OW_OIDC_JWKS_URL?: string;
}

const MODES: IdentityMode[] = ['single-user', 'ha-ingress', 'proxy-header', 'oidc-bearer'];

export function resolveIdentityMode(env: IdentityEnv = process.env): IdentityMode {
    const configured = env.OW_AUTH_MODE?.trim();
    if (configured && (MODES as string[]).includes(configured)) return configured as IdentityMode;
    return 'single-user';
}

/** Header-Werte kommen von außen: Zeilenumbrüche und Leerraum raus. */
function sanitize(value: string | null | undefined): string | undefined {
    if (!value) return undefined;
    const cleaned = value.replace(/[\r\n]/g, ' ').trim();
    return cleaned === '' ? undefined : cleaned;
}

function splitGroups(value: string | undefined): string[] {
    if (!value) return [];
    return value.split(/[,\s]+/).map(entry => entry.trim()).filter(Boolean);
}

const singleUser = (): ResolvedIdentity => ({
    userId: DEFAULT_USER_ID,
    groups: [],
    mode: 'single-user',
    authenticated: false,
});

/**
 * Identität aus den Headern einer Anfrage.
 *
 * Ohne Header (Hintergrundaufgaben, Start-Code) liefert jede Betriebsart
 * den Einzelnutzer zurück — mit `authenticated: false`, damit niemand die
 * Herkunft verwechselt.
 */
export async function resolveIdentity(
    headers?: Headers,
    env: IdentityEnv = process.env,
    fetchImpl: typeof fetch = fetch,
): Promise<ResolvedIdentity> {
    const mode = resolveIdentityMode(env);
    if (mode === 'single-user' || !headers) {
        return mode === 'single-user' ? singleUser() : { ...singleUser(), mode };
    }

    if (mode === 'ha-ingress') {
        // Der Supervisor setzt diese Header für jede Ingress-Anfrage.
        const userId = sanitize(headers.get('x-remote-user-id'));
        const displayName = sanitize(headers.get('x-remote-user-display-name'))
            ?? sanitize(headers.get('x-remote-user-name'));
        if (!userId) {
            return { ...singleUser(), mode, reason: 'Home Assistant hat keinen Nutzer mitgeschickt.' };
        }
        return { userId, groups: [], mode, authenticated: true, displayName };
    }

    if (mode === 'proxy-header') {
        const userHeader = env.OW_AUTH_USER_HEADER ?? 'x-forwarded-user';
        const nameHeader = env.OW_AUTH_NAME_HEADER ?? 'x-forwarded-preferred-username';
        const groupsHeader = env.OW_AUTH_GROUPS_HEADER ?? 'x-forwarded-groups';
        const userId = sanitize(headers.get(userHeader));
        if (!userId) {
            return {
                ...singleUser(),
                mode,
                reason: `Der vorgelagerte Proxy hat keinen Header "${userHeader}" gesetzt.`,
            };
        }
        return {
            userId,
            groups: splitGroups(sanitize(headers.get(groupsHeader))),
            mode,
            authenticated: true,
            displayName: sanitize(headers.get(nameHeader)),
        };
    }

    // oidc-bearer
    const issuer = env.OW_OIDC_ISSUER?.trim();
    if (!issuer) {
        return { ...singleUser(), mode, reason: 'OW_OIDC_ISSUER ist nicht gesetzt.' };
    }
    const authorization = sanitize(headers.get('authorization'));
    const token = authorization?.toLowerCase().startsWith('bearer ')
        ? authorization.slice(7).trim()
        : undefined;
    if (!token) {
        return { ...singleUser(), mode, reason: 'Kein Bearer-Token in der Anfrage.' };
    }
    try {
        const claims = await verifyOidcToken(
            token,
            {
                issuer,
                audience: env.OW_OIDC_AUDIENCE?.trim() || undefined,
                jwksUrl: env.OW_OIDC_JWKS_URL?.trim() || undefined,
            },
            fetchImpl,
        );
        const groupsClaim = claims.groups;
        return {
            userId: typeof claims.sub === 'string' && claims.sub ? claims.sub : DEFAULT_USER_ID,
            groups: Array.isArray(groupsClaim) ? groupsClaim.filter((g): g is string => typeof g === 'string') : [],
            mode,
            authenticated: true,
            displayName: typeof claims.name === 'string' ? claims.name
                : typeof claims.preferred_username === 'string' ? claims.preferred_username
                : undefined,
        };
    } catch (error) {
        const reason = error instanceof OidcError ? error.message : 'Token konnte nicht geprüft werden.';
        return { ...singleUser(), mode, reason };
    }
}
