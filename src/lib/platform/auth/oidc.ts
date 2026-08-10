/**
 * OIDC-Token-Prüfung ohne zusätzliche Abhängigkeit (SPEC §5.2, M12).
 *
 * Warum selbst gebaut: Die Prüfung eines signierten JWT ist WebCrypto plus
 * Base64url — beides steht in Node wie im Edge-Runtime bereit. Eine
 * JOSE-Bibliothek würde hier nichts leisten, was nicht ohnehin geschrieben
 * werden müsste (Discovery, Schlüssel-Cache, Claim-Prüfung), aber das
 * Bundle jeder Route vergrößern.
 *
 * Bewusst NICHT gebaut: der Anmeldefluss (Authorization Code, Sitzungs-
 * Cookies, Refresh). Den übernimmt in der Runtime `server` der oauth2-proxy
 * vor der App (deploy/server/docker-compose.yml) — die App liest dann nur
 * die Identität aus den Headern. Dieses Modul deckt den anderen Fall ab:
 * Clients, die selbst ein Token mitbringen (`Authorization: Bearer …`).
 */

export interface JwtClaims {
    iss?: string;
    sub?: string;
    aud?: string | string[];
    exp?: number;
    nbf?: number;
    iat?: number;
    [claim: string]: unknown;
}

export interface OidcConfig {
    /** Issuer, exakt wie im Token erwartet. */
    issuer: string;
    /** Erwartete Audience (Client-ID). Leer = Audience wird nicht geprüft. */
    audience?: string;
    /** JWKS-URL. Ohne Angabe über die Discovery des Issuers ermittelt. */
    jwksUrl?: string;
    /** Toleranz für Uhrendrift in Sekunden. */
    clockToleranceSeconds?: number;
}

export class OidcError extends Error {
    constructor(message: string, readonly code:
        | 'MALFORMED'
        | 'UNSUPPORTED_ALGORITHM'
        | 'UNKNOWN_KEY'
        | 'BAD_SIGNATURE'
        | 'EXPIRED'
        | 'NOT_YET_VALID'
        | 'WRONG_ISSUER'
        | 'WRONG_AUDIENCE'
        | 'DISCOVERY_FAILED',
    ) {
        super(message);
        this.name = 'OidcError';
    }
}

interface Jwk {
    kid?: string;
    kty: string;
    alg?: string;
    use?: string;
    crv?: string;
    n?: string;
    e?: string;
    x?: string;
    y?: string;
}

/** JWS-Algorithmen, die wir prüfen können — alles andere wird abgelehnt. */
const ALGORITHMS: Record<string, { importAlgorithm: RsaHashedImportParams | EcKeyImportParams; verifyAlgorithm: AlgorithmIdentifier | EcdsaParams }> = {
    RS256: { importAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verifyAlgorithm: { name: 'RSASSA-PKCS1-v1_5' } },
    RS384: { importAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' }, verifyAlgorithm: { name: 'RSASSA-PKCS1-v1_5' } },
    RS512: { importAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }, verifyAlgorithm: { name: 'RSASSA-PKCS1-v1_5' } },
    PS256: { importAlgorithm: { name: 'RSA-PSS', hash: 'SHA-256' }, verifyAlgorithm: { name: 'RSA-PSS', saltLength: 32 } as AlgorithmIdentifier },
    ES256: { importAlgorithm: { name: 'ECDSA', namedCurve: 'P-256' }, verifyAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } },
    ES384: { importAlgorithm: { name: 'ECDSA', namedCurve: 'P-384' }, verifyAlgorithm: { name: 'ECDSA', hash: 'SHA-384' } },
};

function base64UrlToBytes(value: string): Uint8Array {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function decodeJson(segment: string): Record<string, unknown> {
    try {
        return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
    } catch {
        throw new OidcError('Token-Segment ist kein gültiges JSON.', 'MALFORMED');
    }
}

interface CachedKeys {
    keys: Jwk[];
    fetchedAt: number;
    url: string;
}

const KEY_CACHE_TTL_MS = 10 * 60_000;
const keyCache = new Map<string, CachedKeys>();

/** Nur für Tests: Schlüssel-Cache leeren. */
export function clearJwksCache(): void {
    keyCache.clear();
}

async function discoverJwksUrl(config: OidcConfig, fetchImpl: typeof fetch): Promise<string> {
    if (config.jwksUrl) return config.jwksUrl;
    const discovery = `${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const response = await fetchImpl(discovery);
    if (!response.ok) {
        throw new OidcError(`Discovery des Issuers antwortete mit ${response.status}.`, 'DISCOVERY_FAILED');
    }
    const document = (await response.json()) as { jwks_uri?: string };
    if (!document.jwks_uri) {
        throw new OidcError('Discovery-Dokument nennt keine `jwks_uri`.', 'DISCOVERY_FAILED');
    }
    return document.jwks_uri;
}

async function loadKeys(config: OidcConfig, fetchImpl: typeof fetch, force: boolean): Promise<Jwk[]> {
    const cached = keyCache.get(config.issuer);
    if (!force && cached && Date.now() - cached.fetchedAt < KEY_CACHE_TTL_MS) return cached.keys;

    const url = await discoverJwksUrl(config, fetchImpl);
    const response = await fetchImpl(url);
    if (!response.ok) {
        throw new OidcError(`JWKS-Abruf antwortete mit ${response.status}.`, 'DISCOVERY_FAILED');
    }
    const document = (await response.json()) as { keys?: Jwk[] };
    const keys = document.keys ?? [];
    keyCache.set(config.issuer, { keys, fetchedAt: Date.now(), url });
    return keys;
}

function importKey(jwk: Jwk, algorithm: string): Promise<CryptoKey> {
    const spec = ALGORITHMS[algorithm];
    return crypto.subtle.importKey('jwk', jwk as JsonWebKey, spec.importAlgorithm, false, ['verify']);
}

/**
 * Prüft ein JWT gegen die JWKS des Issuers und liefert die Claims.
 *
 * Reihenfolge ist Absicht: erst Struktur, dann Signatur, dann Gültigkeit.
 * Ein Token mit falscher Signatur darf nie an der Ablauf-Prüfung scheitern
 * — sonst verrät die Fehlermeldung mehr als sie darf.
 */
export async function verifyOidcToken(
    token: string,
    config: OidcConfig,
    fetchImpl: typeof fetch = fetch,
): Promise<JwtClaims> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new OidcError('Token hat nicht die Form header.payload.signature.', 'MALFORMED');
    const [headerSegment, payloadSegment, signatureSegment] = parts;

    const header = decodeJson(headerSegment) as { alg?: string; kid?: string };
    const algorithm = header.alg ?? '';
    if (!ALGORITHMS[algorithm]) {
        throw new OidcError(`Signaturverfahren "${algorithm || 'unbekannt'}" wird nicht unterstützt.`, 'UNSUPPORTED_ALGORITHM');
    }

    const signature = base64UrlToBytes(signatureSegment);
    const signed = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);

    let keys = await loadKeys(config, fetchImpl, false);
    let candidates = keys.filter(key => (header.kid ? key.kid === header.kid : true));
    if (candidates.length === 0) {
        // Schlüsselrotation: einmal frisch laden, bevor wir ablehnen.
        keys = await loadKeys(config, fetchImpl, true);
        candidates = keys.filter(key => (header.kid ? key.kid === header.kid : true));
    }
    if (candidates.length === 0) {
        throw new OidcError('Kein passender Signaturschlüssel beim Issuer gefunden.', 'UNKNOWN_KEY');
    }

    let verified = false;
    for (const jwk of candidates) {
        try {
            const key = await importKey(jwk, algorithm);
            verified = await crypto.subtle.verify(
                ALGORITHMS[algorithm].verifyAlgorithm,
                key,
                signature as unknown as BufferSource,
                signed as unknown as BufferSource,
            );
        } catch {
            verified = false;
        }
        if (verified) break;
    }
    if (!verified) throw new OidcError('Signatur des Tokens ist ungültig.', 'BAD_SIGNATURE');

    const claims = decodeJson(payloadSegment) as JwtClaims;
    const tolerance = config.clockToleranceSeconds ?? 60;
    const now = Math.floor(Date.now() / 1000);

    if (claims.iss !== config.issuer) {
        throw new OidcError('Token stammt von einem anderen Issuer.', 'WRONG_ISSUER');
    }
    if (config.audience) {
        const audience = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
        if (!audience.includes(config.audience)) {
            throw new OidcError('Token ist nicht für diese Anwendung ausgestellt.', 'WRONG_AUDIENCE');
        }
    }
    if (typeof claims.exp === 'number' && now > claims.exp + tolerance) {
        throw new OidcError('Token ist abgelaufen.', 'EXPIRED');
    }
    if (typeof claims.nbf === 'number' && now + tolerance < claims.nbf) {
        throw new OidcError('Token ist noch nicht gültig.', 'NOT_YET_VALID');
    }
    return claims;
}
