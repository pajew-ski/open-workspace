/**
 * `rdf-file`-Connector (SPEC §6.3): Turtle/JSON-LD/N-Quads/RDF-XML von
 * einer URL, materialisierend, read-only.
 *
 * Revision = SHA-256 des Datei-Inhalts. Das ist quellen-agnostisch und
 * robuster als ETag/Last-Modified (viele Hosts liefern schwache oder
 * keine Validatoren); Preis ist ein voller Download pro Prüfung —
 * für Einzeldateien akzeptabel, dokumentiert.
 */

import type { Quad } from '@rdfjs/types';
import { z } from 'zod';
import type { Connector, ConnectorContext, SourceRef } from './types';
import { readBodyLimited } from './http';
import { parseRdfLenient, relabelBlankNodes, sha256Hex } from './quads';

const configSchema = z.object({
    url: z.url({ protocol: /^https?$/ }),
});

export type RdfFileConfig = z.infer<typeof configSchema>;

async function fetchSource(url: string, ctx: ConnectorContext): Promise<{ body: string; contentType: string | null; revision: string }> {
    const response = await ctx.fetch(url, { headers: { Accept: 'text/turtle, application/trig, application/ld+json, application/n-quads, application/n-triples, application/rdf+xml, */*;q=0.1' } });
    if (!response.ok) {
        throw new Error(`Quelle antwortet mit HTTP ${response.status}.`);
    }
    const body = await readBodyLimited(response);
    return {
        body,
        contentType: response.headers.get('content-type'),
        revision: `sha256:${await sha256Hex(body)}`,
    };
}

export const rdfFileConnector: Connector<RdfFileConfig> = {
    kind: 'rdf-file',
    mode: 'materialize',
    capabilities: { read: true, write: false, watch: false, lossyExport: false },
    label: 'RDF-Datei (URL)',
    description: 'Einzelne RDF-Datei (Turtle, TriG, JSON-LD, N-Quads, N-Triples, RDF/XML) von einer öffentlichen URL.',

    configSchema: () => z.toJSONSchema(configSchema) as Record<string, unknown>,
    parseConfig: input => configSchema.parse(input),

    locatorFor: config => config.url,
    configFromLocator: locator => configSchema.parse({ url: locator }),

    async probe(config, ctx): Promise<SourceRef> {
        const { revision } = await fetchSource(config.url, ctx);
        return {
            id: '',
            kind: this.kind,
            locator: config.url,
            revision,
            fetchedAt: new Date().toISOString(),
        };
    },

    async *pull(ref: SourceRef, ctx: ConnectorContext): AsyncIterable<Quad> {
        ctx.report({ done: 0, total: 1, note: 'Lade Datei…' });
        const { body, contentType } = await fetchSource(ref.locator, ctx);
        const parsed = parseRdfLenient(body, {
            source: ref.locator,
            contentType,
            path: new URL(ref.locator).pathname,
            baseIri: ref.locator,
        });
        for (const entry of parsed.quarantined) {
            ctx.quarantine(entry);
        }
        yield* relabelBlankNodes(parsed.quads, 'f0');
        ctx.report({ done: 1, total: 1 });
    },
};
