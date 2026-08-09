/**
 * `a2a-agent-card`-Connector (SPEC §6.3, Meilenstein M9): eine A2A-Agent-
 * Card wird als `ow:Agent`-Knoten materialisiert — read-only, über den
 * EINEN Connector-Vertrag (Invariante 5).
 *
 * Die Discovery-Reihenfolge (/.well-known/agent-card.json →
 * /.well-known/agent.json → Wurzel) kommt aus dem bestehenden A2A-Client
 * (`agentCardCandidates`) — der Protokoll-Client wird wiederverwendet,
 * nicht neu gebaut (SPEC §1). Der Netzwerkzugriff läuft trotzdem über
 * `ctx.fetch` (SSRF-Guard), nicht über das globale fetch des Clients.
 *
 * Mapping (SPEC §4.2): Agent → foaf:Agent + ow:Agent +
 * schema:SoftwareApplication mit ow:agentCardUrl, ow:endpoint,
 * ow:securityScheme (JSON-Literal, quelltreu); Card-Skills →
 * ow:Skill-Knoten mit ow:providesSkill-Kante vom Agenten.
 *
 * Revision = SHA-256 des Card-Bodys (wie rdf-file). Fehlertoleranz
 * (M3-Regel): eine erreichbare, aber unbrauchbare Card (kein JSON-Objekt)
 * bricht den Import nicht ab — sie wird quarantäniert; kaputte Einzel-
 * Skills werden einzeln quarantäniert, der Rest wird importiert.
 */

import type { Quad } from '@rdfjs/types';
import { z } from 'zod';
import { agentCardCandidates } from '@/lib/ai/a2a/client';
import type { Connector, ConnectorContext, QuarantineEntry, SourceRef } from './types';
import { readBodyLimited } from './http';
import { sha256Hex } from './quads';
import type { IriFactory } from '../iri';
import { factory, namedNode, literal, typedLiteral } from '../rdf';
import { DCTERMS, FOAF, OW, RDF, SCHEMA } from '../vocab';

const configSchema = z.object({
    /** Origin, JSON-RPC-Endpoint oder direkte Card-URL (…/agent-card.json). */
    url: z.url({ protocol: /^https?$/ }),
});

export type A2aAgentCardConfig = z.infer<typeof configSchema>;

interface ResolvedCard {
    cardUrl: string;
    body: string;
    /** null, wenn der Body kein JSON-Objekt ist (→ Quarantäne beim Pull). */
    data: Record<string, unknown> | null;
}

function parseJsonObject(body: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(body);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

/**
 * Löst die Card gegen die Kandidaten-Reihenfolge des A2A-Clients auf.
 * Erreichbarkeitsprobleme (kein Kandidat antwortet brauchbar) sind ein
 * Infrastrukturfehler; eine explizit angegebene .json-URL wird dagegen
 * auch mit unbrauchbarem Inhalt akzeptiert (Quell-Qualität → Quarantäne).
 */
async function resolveCard(url: string, ctx: ConnectorContext): Promise<ResolvedCard> {
    const candidates = agentCardCandidates(url);
    const explicit = candidates.length === 1;
    let lastError = '';
    for (const candidate of candidates) {
        let response: Response;
        try {
            response = await ctx.fetch(candidate, { headers: { Accept: 'application/json' } });
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            continue;
        }
        if (!response.ok) {
            lastError = `HTTP ${response.status} bei ${candidate}`;
            continue;
        }
        const body = await readBodyLimited(response);
        const data = parseJsonObject(body);
        if (data && ('name' in data || 'url' in data)) {
            return { cardUrl: candidate, body, data };
        }
        if (explicit) {
            // Die eine, ausdrücklich benannte Quelle: importieren, was geht —
            // die Qualitätsentscheidung fällt beim Pull (Quarantäne).
            return { cardUrl: candidate, body, data };
        }
        lastError = `Keine Agent Card unter ${candidate}`;
    }
    throw new Error(`Agent Card nicht gefunden: ${lastError}`);
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Stabile Skill-Kennung einer Card-Position (id → name → Index). */
function skillIdentifier(entry: Record<string, unknown>, index: number): string {
    return asString(entry.id) ?? asString(entry.name) ?? `skill-${index + 1}`;
}

/**
 * Reines Mapping Card → Quads (ohne Graph-Komponente — den Ziel-Graphen
 * erzwingt der Runner). Exportiert, damit die M9-Abnahme das Mapping
 * direkt testen kann.
 */
export function agentCardQuads(
    iri: IriFactory,
    connectorId: string,
    card: Record<string, unknown>,
    cardUrl: string,
    quarantine: (entry: QuarantineEntry) => void,
): Quad[] {
    const agent = namedNode(iri.entity('agent', connectorId));
    const type = namedNode(RDF.type);
    const quads: Quad[] = [
        factory.quad(agent, type, namedNode(FOAF.Agent)),
        factory.quad(agent, type, namedNode(OW.Agent)),
        factory.quad(agent, type, namedNode(SCHEMA.SoftwareApplication)),
        factory.quad(agent, namedNode(OW.agentCardUrl), typedLiteral.anyUri(cardUrl)),
    ];

    const name = asString(card.name);
    if (name) quads.push(factory.quad(agent, namedNode(SCHEMA.name), literal(name)));
    const description = asString(card.description);
    if (description) quads.push(factory.quad(agent, namedNode(SCHEMA.description), literal(description)));
    const version = asString(card.version);
    if (version) quads.push(factory.quad(agent, namedNode(SCHEMA.softwareVersion), literal(version)));
    const endpoint = asString(card.url);
    if (endpoint) quads.push(factory.quad(agent, namedNode(OW.endpoint), typedLiteral.anyUri(endpoint)));
    // Quelltreu als JSON-Literal (ow:securityScheme, SPEC §4.3): eine
    // tripelweise Abbildung der A2A-Security-Struktur wäre verlustbehaftet.
    if (card.securitySchemes && typeof card.securitySchemes === 'object') {
        quads.push(factory.quad(agent, namedNode(OW.securityScheme), literal(JSON.stringify(card.securitySchemes))));
    }

    const skills = Array.isArray(card.skills) ? card.skills : [];
    if (card.skills !== undefined && !Array.isArray(card.skills)) {
        quarantine({ source: `${cardUrl}#skills`, reason: 'Feld "skills" ist keine Liste — übersprungen.' });
    }
    skills.forEach((entry: unknown, index: number) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            quarantine({ source: `${cardUrl}#skills[${index}]`, reason: 'Skill-Eintrag ist kein Objekt — übersprungen.' });
            return;
        }
        const skillEntry = entry as Record<string, unknown>;
        const identifier = skillIdentifier(skillEntry, index);
        const skill = namedNode(iri.entity('skill', `${connectorId}/${identifier}`));
        quads.push(
            factory.quad(skill, type, namedNode(OW.Skill)),
            factory.quad(skill, namedNode(DCTERMS.identifier), literal(identifier)),
            factory.quad(agent, namedNode(OW.providesSkill), skill),
        );
        const skillName = asString(skillEntry.name) ?? identifier;
        quads.push(factory.quad(skill, namedNode(SCHEMA.name), literal(skillName)));
        const skillDescription = asString(skillEntry.description);
        if (skillDescription) {
            quads.push(factory.quad(skill, namedNode(SCHEMA.description), literal(skillDescription)));
        }
        // Herkunft laut Ontologie: Ladeweg samt Locator.
        quads.push(factory.quad(skill, namedNode(OW.skillSource), literal(`a2a-card:${cardUrl}`)));
        if (Array.isArray(skillEntry.tags)) {
            for (const tag of skillEntry.tags) {
                const tagValue = asString(tag);
                if (tagValue) quads.push(factory.quad(skill, namedNode(SCHEMA.keywords), literal(tagValue)));
            }
        }
    });

    return quads;
}

export const a2aAgentCardConnector: Connector<A2aAgentCardConfig> = {
    kind: 'a2a-agent-card',
    mode: 'materialize',
    capabilities: { read: true, write: false, watch: false, lossyExport: false },
    label: 'A2A-Agent-Card',
    description: 'Agent-Card eines A2A-Agenten (/.well-known/agent-card.json): der Agent wird mit Endpoint, Security-Schemes und angebotenen Skills als Graph-Knoten abfragbar.',

    configSchema: () => z.toJSONSchema(configSchema) as Record<string, unknown>,
    parseConfig: input => configSchema.parse(input),

    locatorFor: config => config.url,
    configFromLocator: locator => configSchema.parse({ url: locator }),

    async probe(config, ctx): Promise<SourceRef> {
        const { body } = await resolveCard(config.url, ctx);
        return {
            id: '',
            kind: this.kind,
            locator: config.url,
            revision: `sha256:${await sha256Hex(body)}`,
            fetchedAt: new Date().toISOString(),
        };
    },

    async *pull(ref: SourceRef, ctx: ConnectorContext): AsyncIterable<Quad> {
        ctx.report({ done: 0, total: 1, note: 'Lade Agent Card…' });
        const { cardUrl, data } = await resolveCard(ref.locator, ctx);
        if (!data) {
            ctx.quarantine({
                source: cardUrl,
                reason: 'Antwort ist kein JSON-Objekt — keine Agent Card importierbar.',
            });
            ctx.report({ done: 1, total: 1 });
            return;
        }
        yield* agentCardQuads(ctx.iri, ref.id, data, cardUrl, entry => ctx.quarantine(entry));
        ctx.report({ done: 1, total: 1 });
    },
};
