/**
 * `json-canvas`-Connector (SPEC §6.3, §9 — Meilenstein M5): fremde
 * `.canvas`-Dateien (JSON Canvas 1.0, z. B. aus Obsidian) über den EINEN
 * Connector-Vertrag (Invariante 5).
 *
 *  - `pull` materialisiert die Wissens-Schicht (Canvas-Knoten, semantische
 *    Gegenstücke, ow:linksTo-Kanten) in den Import-Graphen und meldet die
 *    Layout-Schicht über `ctx.presentation()` — der Runner ersetzt damit
 *    die Layout-Gruppe in `graph/<u>/presentation`. Kein Layout-Wert
 *    erreicht je einen semantischen Graphen (Invariante 2).
 *  - `push` schreibt den Graph-Stand als `.canvas` zurück (Direct-Write:
 *    die Datei ist ein lokaler Pfad dieser Installation, kein fremdes
 *    Repo). Konfliktregel §6.2 wie beim obsidian-vault-Connector.
 *  - Revision = Inhalts-Hash der Datei → unveränderte Datei ist ein No-Op.
 *
 * Pfad-Politik: identisch zum Obsidian-Vault (`data/vaults/` bzw.
 * Wurzeln aus OW_VAULT_ROOTS) — ein `.canvas` liegt typischerweise in
 * einem Vault.
 */

import type { Quad } from '@rdfjs/types';
import { z } from 'zod';
import type { FileSystemLike } from '@/lib/platform/runtime/types';
import {
    ConnectorConflictError,
    type ConflictReport,
    type Connector,
    type ConnectorContext,
    type SourceRef,
    type WriteReceipt,
} from '../types';
import { sha256Hex } from '../quads';
import { normalizeVaultPath, resolveVaultRoot } from '../obsidian/vault';
import { projectCanvasToJsonCanvas } from '../../projection/json-canvas';
import { namedNode } from '../../rdf';
import { parseJsonCanvas, serializeJsonCanvas } from './format';
import { buildJsonCanvasQuads } from './map';

const configSchema = z.object({
    /** Pfad der `.canvas`-Datei: `data/vaults/…` oder unter OW_VAULT_ROOTS. */
    path: z.string().min(1, 'Pfad der .canvas-Datei ist erforderlich')
        .regex(/\.canvas$/i, 'Der Pfad muss auf ".canvas" enden'),
});

export type JsonCanvasConfig = z.infer<typeof configSchema>;

function requireFiles(ctx: ConnectorContext): FileSystemLike {
    if (!ctx.files) {
        throw new Error('Diese Runtime stellt keinen Dateizugriff bereit — der json-canvas-Connector braucht ihn.');
    }
    return ctx.files;
}

async function readCanvasFile(locator: string, ctx: ConnectorContext): Promise<{ absolute: string; content: string; revision: string }> {
    const files = requireFiles(ctx);
    const absolute = resolveVaultRoot(locator);
    if (!(await files.exists(absolute))) {
        throw new Error(`Canvas-Datei "${locator}" existiert nicht.`);
    }
    const content = await files.readFile(absolute);
    return { absolute, content, revision: `sha256:${await sha256Hex(content)}` };
}

/** Projektion des aktuellen Graph-Stands dieser Instanz als `.canvas`-Text. */
async function projectFromGraph(ref: SourceRef, ctx: ConnectorContext): Promise<string> {
    const semantic: Quad[] = [];
    for await (const q of ctx.store.dump(namedNode(ctx.iri.importGraph(ref.id)))) {
        semantic.push(q);
    }
    const layout: Quad[] = [];
    for await (const q of ctx.store.dump(namedNode(ctx.iri.graph('presentation')))) {
        layout.push(q);
    }
    const canvasIri = ctx.iri.entity('canvas', ref.id);
    return serializeJsonCanvas(projectCanvasToJsonCanvas(canvasIri, semantic, layout));
}

export const jsonCanvasConnector: Connector<JsonCanvasConfig> = {
    kind: 'json-canvas',
    mode: 'materialize',
    capabilities: { read: true, write: true, watch: false, lossyExport: true },
    label: 'JSON Canvas (.canvas)',
    description: 'Einzelne .canvas-Datei (JSON Canvas 1.0, z. B. aus Obsidian): Wissen in den Import-Graphen, Layout nach graph/presentation; Export schreibt die Datei normalisiert zurück.',

    configSchema: () => z.toJSONSchema(configSchema) as Record<string, unknown>,
    parseConfig: input => {
        const parsed = configSchema.parse(input);
        normalizeVaultPath(parsed.path);
        return parsed;
    },

    locatorFor: config => normalizeVaultPath(config.path),
    configFromLocator: locator => configSchema.parse({ path: locator }),

    async probe(config, ctx): Promise<SourceRef> {
        const locator = normalizeVaultPath(config.path);
        const { revision } = await readCanvasFile(locator, ctx);
        return {
            id: '',
            kind: this.kind,
            locator,
            revision,
            fetchedAt: new Date().toISOString(),
        };
    },

    async *pull(ref: SourceRef, ctx: ConnectorContext): AsyncIterable<Quad> {
        const { content } = await readCanvasFile(ref.locator, ctx);
        const parsed = parseJsonCanvas(content, ref.locator);
        for (const issue of parsed.issues) {
            ctx.quarantine({ source: issue.source, reason: issue.reason });
        }
        const result = buildJsonCanvasQuads(parsed.canvas, ctx.iri, ref.id, ref.locator);
        ctx.report({ done: result.nodes, total: result.nodes, note: `${result.nodes} Knoten, ${result.edges} Kanten` });
        ctx.presentation({ canvasIri: result.canvasIri, quads: result.layout });
        yield* result.semantic;
    },

    async push(ref: SourceRef, _delta, ctx): Promise<WriteReceipt> {
        const files = requireFiles(ctx);
        const { absolute, content, revision: currentRevision } = await readCanvasFile(ref.locator, ctx);
        const projected = await projectFromGraph(ref, ctx);

        // Konfliktregel (SPEC §6.2): ohne Pull kein Schreiben; bei
        // zwischenzeitlicher externer Änderung erst synchronisieren.
        const lastPulled = ref.revision;
        if (lastPulled === undefined || lastPulled !== currentRevision) {
            const report: ConflictReport = {
                sourceRevision: currentRevision,
                lastPulledRevision: lastPulled,
                conflicts: [{ path: ref.locator, reason: 'Datei weicht vom Stand des letzten Sync ab.' }],
            };
            throw new ConnectorConflictError(
                lastPulled === undefined
                    ? 'Die Datei wurde noch nie synchronisiert — erst synchronisieren, dann exportieren.'
                    : 'Die Datei wurde seit dem letzten Sync extern verändert — erst synchronisieren, dann exportieren.',
                report,
            );
        }

        if (projected !== content) {
            await files.writeFile(absolute, projected);
        }
        return {
            mode: 'direct',
            revision: `sha256:${await sha256Hex(projected)}`,
        };
    },

    async reconcile(ref: SourceRef, ctx: ConnectorContext): Promise<ConflictReport> {
        const { content, revision } = await readCanvasFile(ref.locator, ctx);
        const projected = await projectFromGraph(ref, ctx);
        return {
            sourceRevision: revision,
            lastPulledRevision: ref.revision,
            conflicts: projected === content
                ? []
                : [{ path: ref.locator, reason: 'Inhalt weicht vom Stand des Graphen ab.' }],
        };
    },
};
