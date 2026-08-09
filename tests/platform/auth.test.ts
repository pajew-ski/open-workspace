// @vitest-environment node
/**
 * Identität der Runtimes `server`/`ha-addon` (SPEC §5.2, M12).
 *
 * Die vier Betriebsarten aus `OW_AUTH_MODE` — und die Token-Prüfung, die
 * `oidc-bearer` trägt. Die Signaturen sind echt: der Test erzeugt ein
 * Schlüsselpaar über WebCrypto, signiert damit und lässt die
 * JWKS-Auflösung über einen Stub laufen. Kein Mock der Prüfung selbst,
 * sonst prüfte der Test sich selbst.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resolveIdentity, resolveIdentityMode } from '../../src/lib/platform/auth/identity';
import { clearJwksCache, OidcError, verifyOidcToken } from '../../src/lib/platform/auth/oidc';
import { DEFAULT_USER_ID } from '../../src/lib/graph/iri';

const ISSUER = 'https://id.example.org/realms/main';
const AUDIENCE = 'open-workspace';

function base64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeSegment(value: unknown): string {
    return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

interface Signer {
    kid: string;
    /** JWK plus `kid`/`alg` — die Toolchain-Typen kennen beide Felder nicht. */
    jwk: JsonWebKey & Record<string, unknown>;
    sign(claims: Record<string, unknown>, kid?: string): Promise<string>;
}

async function createSigner(kid: string): Promise<Signer> {
    const pair = await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
    );
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    return {
        kid,
        jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' },
        sign: async (claims, headerKid = kid) => {
            const header = encodeSegment({ alg: 'RS256', typ: 'JWT', kid: headerKid });
            const payload = encodeSegment(claims);
            const signature = new Uint8Array(await crypto.subtle.sign(
                'RSASSA-PKCS1-v1_5',
                pair.privateKey,
                new TextEncoder().encode(`${header}.${payload}`),
            ));
            return `${header}.${payload}.${base64Url(signature)}`;
        },
    };
}

function jwksFetch(signers: Signer[], counter?: { discovery: number; jwks: number }): typeof fetch {
    return (async (input: string) => {
        const url = String(input);
        if (url.endsWith('/.well-known/openid-configuration')) {
            if (counter) counter.discovery += 1;
            return new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}/keys` }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (url === `${ISSUER}/keys`) {
            if (counter) counter.jwks += 1;
            return new Response(JSON.stringify({ keys: signers.map(signer => signer.jwk) }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }
        return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
}

const now = () => Math.floor(Date.now() / 1000);

const validClaims = (overrides: Record<string, unknown> = {}) => ({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'user-42',
    name: 'Ada Lovelace',
    groups: ['workspace', 'admin'],
    iat: now() - 10,
    exp: now() + 600,
    ...overrides,
});

describe('OIDC-Token-Prüfung', () => {
    beforeEach(() => clearJwksCache());

    it('nimmt ein gültiges Token an — Schlüssel über die Discovery', async () => {
        const signer = await createSigner('key-1');
        const counter = { discovery: 0, jwks: 0 };
        const claims = await verifyOidcToken(
            await signer.sign(validClaims()),
            { issuer: ISSUER, audience: AUDIENCE },
            jwksFetch([signer], counter),
        );
        expect(claims.sub).toBe('user-42');
        expect(counter.discovery).toBe(1);

        // Zweites Token: Schlüssel kommen aus dem Cache.
        await verifyOidcToken(await signer.sign(validClaims()), { issuer: ISSUER, audience: AUDIENCE }, jwksFetch([signer], counter));
        expect(counter.jwks).toBe(1);
    });

    it('lehnt manipulierte Signaturen ab', async () => {
        const signer = await createSigner('key-1');
        const token = await signer.sign(validClaims());
        const [header, , signature] = token.split('.');
        const tampered = `${header}.${encodeSegment(validClaims({ sub: 'jemand-anders' }))}.${signature}`;

        await expect(verifyOidcToken(tampered, { issuer: ISSUER }, jwksFetch([signer])))
            .rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
    });

    it('prüft Ablauf, Issuer und Audience — in dieser Reihenfolge nach der Signatur', async () => {
        const signer = await createSigner('key-1');
        const fetchImpl = jwksFetch([signer]);

        await expect(verifyOidcToken(await signer.sign(validClaims({ exp: now() - 3600 })), { issuer: ISSUER }, fetchImpl))
            .rejects.toMatchObject({ code: 'EXPIRED' });
        await expect(verifyOidcToken(await signer.sign(validClaims({ iss: 'https://boese.example' })), { issuer: ISSUER }, fetchImpl))
            .rejects.toMatchObject({ code: 'WRONG_ISSUER' });
        await expect(verifyOidcToken(await signer.sign(validClaims({ aud: 'andere-app' })), { issuer: ISSUER, audience: AUDIENCE }, fetchImpl))
            .rejects.toMatchObject({ code: 'WRONG_AUDIENCE' });
        await expect(verifyOidcToken(await signer.sign(validClaims({ nbf: now() + 3600 })), { issuer: ISSUER }, fetchImpl))
            .rejects.toMatchObject({ code: 'NOT_YET_VALID' });
    });

    it('lehnt `alg: none` und unbekannte Verfahren ab', async () => {
        const signer = await createSigner('key-1');
        const header = encodeSegment({ alg: 'none', typ: 'JWT' });
        const token = `${header}.${encodeSegment(validClaims())}.`;
        await expect(verifyOidcToken(token, { issuer: ISSUER }, jwksFetch([signer])))
            .rejects.toMatchObject({ code: 'UNSUPPORTED_ALGORITHM' });
        await expect(verifyOidcToken('kein.jwt', { issuer: ISSUER }, jwksFetch([signer])))
            .rejects.toBeInstanceOf(OidcError);
    });

    it('lädt die Schlüssel nach, wenn der Issuer rotiert hat', async () => {
        const alt = await createSigner('key-1');
        const neu = await createSigner('key-2');
        const counter = { discovery: 0, jwks: 0 };

        // Erst nur der alte Schlüssel — füllt den Cache.
        await verifyOidcToken(await alt.sign(validClaims()), { issuer: ISSUER }, jwksFetch([alt], counter));
        expect(counter.jwks).toBe(1);

        // Neues kid: der Cache kennt es nicht, ein frischer Abruf hilft.
        const claims = await verifyOidcToken(await neu.sign(validClaims()), { issuer: ISSUER }, jwksFetch([alt, neu], counter));
        expect(claims.sub).toBe('user-42');
        expect(counter.jwks).toBe(2);
    });
});

describe('Identität aus der Anfrage', () => {
    beforeEach(() => clearJwksCache());

    it('ist ohne Konfiguration Einzelnutzer — ehrlich als „nicht angemeldet"', async () => {
        expect(resolveIdentityMode({})).toBe('single-user');
        expect(resolveIdentityMode({ OW_AUTH_MODE: 'quatsch' })).toBe('single-user');

        const identity = await resolveIdentity(new Headers(), {});
        expect(identity).toMatchObject({ mode: 'single-user', authenticated: false, userId: DEFAULT_USER_ID });
    });

    it('liest den Nutzer aus den Home-Assistant-Ingress-Headern', async () => {
        const identity = await resolveIdentity(
            new Headers({ 'X-Remote-User-Id': 'ha-user-1', 'X-Remote-User-Display-Name': 'Michael' }),
            { OW_AUTH_MODE: 'ha-ingress' },
        );
        expect(identity).toMatchObject({ mode: 'ha-ingress', authenticated: true, userId: 'ha-user-1', displayName: 'Michael' });

        const ohne = await resolveIdentity(new Headers(), { OW_AUTH_MODE: 'ha-ingress' });
        expect(ohne.authenticated).toBe(false);
        expect(ohne.reason).toMatch(/Home Assistant/);
    });

    it('liest den Nutzer aus den Headern des Anmelde-Proxys', async () => {
        const identity = await resolveIdentity(
            new Headers({
                'X-Forwarded-User': 'ada@example.org',
                'X-Forwarded-Preferred-Username': 'ada',
                'X-Forwarded-Groups': 'workspace,admin',
            }),
            { OW_AUTH_MODE: 'proxy-header' },
        );
        expect(identity).toMatchObject({
            mode: 'proxy-header',
            authenticated: true,
            userId: 'ada@example.org',
            displayName: 'ada',
            groups: ['workspace', 'admin'],
        });

        const fehlend = await resolveIdentity(new Headers(), { OW_AUTH_MODE: 'proxy-header' });
        expect(fehlend.authenticated).toBe(false);
        expect(fehlend.reason).toMatch(/x-forwarded-user/);
    });

    it('prüft ein mitgebrachtes Token — und verweigert bei jedem Zweifel', async () => {
        const signer = await createSigner('key-1');
        const env = { OW_AUTH_MODE: 'oidc-bearer', OW_OIDC_ISSUER: ISSUER, OW_OIDC_AUDIENCE: AUDIENCE };
        const fetchImpl = jwksFetch([signer]);

        const identity = await resolveIdentity(
            new Headers({ Authorization: `Bearer ${await signer.sign(validClaims())}` }),
            env,
            fetchImpl,
        );
        expect(identity).toMatchObject({
            mode: 'oidc-bearer',
            authenticated: true,
            userId: 'user-42',
            displayName: 'Ada Lovelace',
            groups: ['workspace', 'admin'],
        });

        const abgelaufen = await resolveIdentity(
            new Headers({ Authorization: `Bearer ${await signer.sign(validClaims({ exp: now() - 3600 }))}` }),
            env,
            fetchImpl,
        );
        expect(abgelaufen.authenticated).toBe(false);
        expect(abgelaufen.userId).toBe(DEFAULT_USER_ID);
        expect(abgelaufen.reason).toMatch(/abgelaufen/);

        const ohneToken = await resolveIdentity(new Headers(), env, fetchImpl);
        expect(ohneToken.authenticated).toBe(false);
        expect(ohneToken.reason).toMatch(/Bearer/);
    });
});
