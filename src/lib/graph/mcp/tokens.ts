/**
 * MCP-Token-Konfiguration (SPEC §7.6, M10).
 *
 * „Ein MCP-Token ist an eine Identität und deren erlaubtes Dataset
 * gebunden." Bis `graph/acl` mit M13 existiert, ist die Bindung explizite
 * Konfiguration: eine JSON-Liste in `OW_MCP_TOKENS`. Damit gilt
 *
 *  - **Secure by default**: Ohne konfigurierte Tokens gibt es keinen
 *    eingehenden MCP-Zugriff. Der Endpoint antwortet ehrlich mit 503 und
 *    dem Konfigurationshinweis, statt den Graphen anonym zu öffnen.
 *  - **Keine Rechte-Erfindung**: Ein Token nennt seine Scopes; daraus wird
 *    über `resolveGrantGraphs` das erlaubte Dataset. `graph/acl` ist über
 *    kein Muster erreichbar.
 *  - **graph_write bleibt aus**, bis ein Token es ausdrücklich mitbringt
 *    (`write: true` + gültiges `writeScope`).
 *
 * MIGRATION: Mit M13 wandert die Rechtevergabe nach `graph/acl`; diese
 * Datei bleibt dann nur noch die Token→Identität-Abbildung.
 */

import { z } from 'zod';
import type { IriFactory } from '../iri';
import { resolveGrantGraphs, resolveWriteGraph, scopeMatches, WRITE_SCOPE_HINT, type AccessGrant } from '../authz/grant';

export const MCP_TOKENS_ENV = 'OW_MCP_TOKENS';

const scopePattern = z.string().min(1).max(200);

const tokenSchema = z.object({
    /** Stabile Identität des Tokens — taucht in PROV und Logs auf. */
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, 'ID: Buchstaben, Ziffern, . _ -'),
    label: z.string().max(200).optional(),
    /** Gemeinsames Geheimnis (Bearer). Mindestens 16 Zeichen. */
    token: z.string().min(16, 'Token: mindestens 16 Zeichen'),
    /** Lesbare Graphen als Scope-Muster (§3.3), z. B. ["workspace","public"]. */
    scopes: z.array(scopePattern).min(1),
    /** Rohe SPARQL-Queries (read-only) erlaubt. Default: aus. */
    sparql: z.boolean().default(false),
    /** graph_write erlauben. Default: aus (SPEC §7.6). */
    write: z.boolean().default(false),
    /** Zielgraph für graph_write: "workspace" | "public" | "shared/<id>". */
    writeScope: z.string().optional(),
    /** Anfragen pro Minute; Default 120 (SPEC §7.6: Rate-Limits Pflicht). */
    rateLimitPerMinute: z.number().int().min(1).max(10_000).default(120),
}).strict();

export type McpTokenConfig = z.infer<typeof tokenSchema>;

export interface McpTokenParseResult {
    tokens: McpTokenConfig[];
    /** Konfigurationsfehler — sichtbar in Status-API und Server-Log. */
    errors: string[];
}

/** Parst die Token-Liste. Ein Fehler kippt nie stillschweigend nach „offen". */
export function parseMcpTokens(raw: string | undefined | null): McpTokenParseResult {
    if (!raw || raw.trim() === '') return { tokens: [], errors: [] };
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { tokens: [], errors: [`${MCP_TOKENS_ENV} ist kein gültiges JSON.`] };
    }
    if (!Array.isArray(parsed)) {
        return { tokens: [], errors: [`${MCP_TOKENS_ENV} muss eine JSON-Liste von Token-Objekten sein.`] };
    }
    const tokens: McpTokenConfig[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    parsed.forEach((entry, index) => {
        const result = tokenSchema.safeParse(entry);
        if (!result.success) {
            errors.push(`${MCP_TOKENS_ENV}[${index}]: ${result.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
            return;
        }
        const token = result.data;
        if (seen.has(token.id)) {
            errors.push(`${MCP_TOKENS_ENV}[${index}]: Token-ID "${token.id}" ist doppelt vergeben.`);
            return;
        }
        if (token.write && !token.writeScope) {
            errors.push(`${MCP_TOKENS_ENV}[${index}]: "write": true verlangt ein "writeScope". ${WRITE_SCOPE_HINT}`);
            return;
        }
        seen.add(token.id);
        tokens.push(token);
    });
    return { tokens, errors };
}

/** Liest die Token-Konfiguration aus der Prozess-Umgebung. */
export function mcpTokensFromEnv(env: Record<string, string | undefined> = process.env): McpTokenParseResult {
    return parseMcpTokens(env[MCP_TOKENS_ENV]);
}

// --- Vergleich ohne Zeit-Seitenkanal -------------------------------------

async function sha256(value: string): Promise<Uint8Array> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return new Uint8Array(digest);
}

/**
 * Vergleicht zwei Geheimnisse über ihre SHA-256-Digests, ohne früh
 * abzubrechen: Länge und Inhalt fließen gleichmäßig ein, damit die
 * Antwortzeit kein Zeichen des Tokens verrät.
 */
export async function secretEquals(a: string, b: string): Promise<boolean> {
    const [da, db] = await Promise.all([sha256(a), sha256(b)]);
    let diff = da.length ^ db.length;
    for (let i = 0; i < da.length; i += 1) diff |= da[i] ^ db[i];
    return diff === 0;
}

/** Bearer-Token aus dem Authorization-Header (RFC 6750). */
export function bearerFromHeaders(headers: Headers): string | null {
    const value = headers.get('authorization');
    if (!value) return null;
    const match = /^Bearer\s+(.+)$/i.exec(value.trim());
    return match ? match[1].trim() : null;
}

/** Sucht das Token — konstante Arbeit über alle Kandidaten. */
export async function findMcpToken(
    tokens: readonly McpTokenConfig[],
    presented: string,
): Promise<McpTokenConfig | null> {
    let found: McpTokenConfig | null = null;
    for (const candidate of tokens) {
        if (await secretEquals(candidate.token, presented) && !found) found = candidate;
    }
    return found;
}

export interface McpGrantResult {
    grant: AccessGrant;
    /** Nicht auflösbares writeScope — ehrlicher Fehler statt stiller Aus-Zustand. */
    writeScopeError?: string;
}

/** Bildet ein Token auf den Grant über den aktuellen Graph-Bestand ab. */
export function grantForToken(
    token: McpTokenConfig,
    iri: IriFactory,
    existingGraphs: readonly string[],
): McpGrantResult {
    const readableGraphs = resolveGrantGraphs(iri, token.scopes, existingGraphs);
    let writableGraph: string | null = null;
    let writeScopeError: string | undefined;
    if (token.write && token.writeScope) {
        const target = resolveWriteGraph(iri, token.writeScope);
        if (!target) {
            writeScopeError = `Ungültiges writeScope "${token.writeScope}". ${WRITE_SCOPE_HINT}`;
        } else if (!token.scopes.some(pattern => scopeMatches(pattern, token.writeScope!))) {
            // Schreiben ohne Leserecht auf denselben Graphen wäre eine
            // zweite Rechte-Welt — der Grant bleibt eine Verengung. Geprüft
            // wird das Muster, nicht die Existenz: ein noch leerer Raum ist
            // ein gültiges Ziel für den ersten Schreibvorgang.
            writeScopeError = `writeScope "${token.writeScope}" liegt außerhalb der Lese-Scopes dieses Tokens.`;
        } else {
            writableGraph = target;
        }
    }
    return {
        grant: {
            identity: token.id,
            readableGraphs,
            writableGraph,
            sparql: token.sparql,
        },
        ...(writeScopeError ? { writeScopeError } : {}),
    };
}
