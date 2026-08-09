/**
 * `obsidian-vault`-Connector (SPEC §6.3, §10 — Meilenstein M4):
 * bidirektionale, verlustbehaftete Kompatibilität mit einem lokalen
 * Obsidian-Vault über den EINEN Connector-Vertrag (Invariante 5).
 *
 *  - `pull` materialisiert alle Markdown-Notizen des Vaults in den
 *    Import-Graphen (Mapping: map.ts). Revision = Inhalts-Hash des
 *    Vault-Bestands → unveränderter Vault ist ein No-Op.
 *  - `push` schreibt den Import-Graphen als Markdown zurück in den Vault
 *    (Projektion: projection/obsidian.ts). Direct-Write statt Branch→PR:
 *    Der Vault ist ein lokaler Ordner dieser Installation, kein fremdes
 *    Repo — es gibt nichts, worauf man einen Pull Request stellen könnte.
 *  - Konfliktregel (SPEC §6.2): Weicht die Vault-Revision von der zuletzt
 *    gepullten ab, ist `push` verboten (ConnectorConflictError) —
 *    `reconcile` benennt die Abweichungen dateigenau.
 *
 * Fehlertoleranz (wie M3): kaputtes Frontmatter oder unlesbare Dateien
 * quarantänieren die Einheit, der Import läuft weiter.
 */

import type { Quad } from '@rdfjs/types';
import { z } from 'zod';
import type { FileSystemLike } from '@/lib/platform/runtime/types';
import { ConnectorConflictError, type ConflictReport, type Connector, type ConnectorContext, type SourceRef, type WriteReceipt } from '../types';
import { projectDocsToMarkdown, type ObsidianExportFile } from '../../projection/obsidian';
import { namedNode } from '../../rdf';
import { normalizeVaultPath, readVaultFiles, resolveVaultRoot, vaultRevision, type VaultFile } from './vault';
import { buildVaultQuads } from './map';

const configSchema = z.object({
    /** Vault-Wurzel: `data/vaults/<name>` oder eine Wurzel aus OW_VAULT_ROOTS. */
    path: z.string().min(1, 'Vault-Pfad ist erforderlich'),
});

export type ObsidianVaultConfig = z.infer<typeof configSchema>;

function requireFiles(ctx: ConnectorContext): FileSystemLike {
    if (!ctx.files) {
        throw new Error('Diese Runtime stellt keinen Dateizugriff bereit — der obsidian-vault-Connector braucht ihn.');
    }
    return ctx.files;
}

async function readVault(locator: string, ctx: ConnectorContext): Promise<{ root: string; files: VaultFile[]; revision: string }> {
    const files = requireFiles(ctx);
    const root = resolveVaultRoot(locator);
    if (!(await files.exists(root))) {
        throw new Error(`Vault-Ordner "${locator}" existiert nicht.`);
    }
    const vaultFiles = await readVaultFiles(files, root, (path, reason) =>
        ctx.quarantine({ source: path, reason: `Datei nicht lesbar: ${reason}` }),
    );
    return { root, files: vaultFiles, revision: await vaultRevision(vaultFiles) };
}

/** Dump des Import-Graphen dieser Instanz als Quad-Liste. */
async function dumpTargetGraph(ref: SourceRef, ctx: ConnectorContext): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const q of ctx.store.dump(namedNode(ctx.iri.importGraph(ref.id)))) {
        quads.push(q);
    }
    return quads;
}

/** Dateigenauer Vergleich Vault-Bestand ↔ Projektion des Import-Graphen. */
function diffVaultAgainstProjection(
    vaultFiles: VaultFile[],
    projected: ObsidianExportFile[],
): Array<{ path: string; reason: string }> {
    const vaultByPath = new Map(vaultFiles.map(file => [file.path, file.content]));
    const projectedByPath = new Map(projected.map(file => [file.path, file.content]));
    const conflicts: Array<{ path: string; reason: string }> = [];
    for (const [path, content] of vaultByPath) {
        const expected = projectedByPath.get(path);
        if (expected === undefined) {
            conflicts.push({ path, reason: 'Nur im Vault vorhanden (im Graphen unbekannt).' });
        } else if (expected !== content) {
            conflicts.push({ path, reason: 'Inhalt weicht vom Stand des Graphen ab.' });
        }
    }
    for (const path of projectedByPath.keys()) {
        if (!vaultByPath.has(path)) {
            conflicts.push({ path, reason: 'Nur im Graphen vorhanden (im Vault gelöscht?).' });
        }
    }
    return conflicts.sort((a, b) => a.path.localeCompare(b.path, 'de'));
}

export const obsidianVaultConnector: Connector<ObsidianVaultConfig> = {
    kind: 'obsidian-vault',
    mode: 'materialize',
    capabilities: { read: true, write: true, watch: false, lossyExport: true },
    label: 'Obsidian-Vault',
    description: 'Lokaler Obsidian-Vault (Markdown-Ordner): Import als ow:Document-Knoten mit Wikilinks, Tags und Frontmatter; verlustbehafteter Export zurück in den Vault.',

    configSchema: () => z.toJSONSchema(configSchema) as Record<string, unknown>,
    parseConfig: input => {
        const parsed = configSchema.parse(input);
        // Früh scheitern statt beim ersten Sync: Pfadform prüfen (die
        // Wurzel-Freigabe prüft resolveVaultRoot beim Zugriff).
        normalizeVaultPath(parsed.path);
        return parsed;
    },

    locatorFor: config => normalizeVaultPath(config.path),
    configFromLocator: locator => configSchema.parse({ path: locator }),

    async probe(config, ctx): Promise<SourceRef> {
        const { revision } = await readVault(normalizeVaultPath(config.path), ctx);
        return {
            id: '',
            kind: this.kind,
            locator: normalizeVaultPath(config.path),
            revision,
            fetchedAt: new Date().toISOString(),
        };
    },

    async *pull(ref: SourceRef, ctx: ConnectorContext): AsyncIterable<Quad> {
        const { files } = await readVault(ref.locator, ctx);
        ctx.report({ done: 0, total: files.length, note: 'Lese Vault…' });
        const result = buildVaultQuads(files, ctx.iri, ref.id);
        for (const entry of result.quarantined) {
            ctx.quarantine(entry);
        }
        yield* result.quads;
        ctx.report({ done: files.length, total: files.length });
    },

    async push(ref: SourceRef, _delta, ctx): Promise<WriteReceipt> {
        const fs = requireFiles(ctx);
        const { root, files: currentFiles, revision: currentRevision } = await readVault(ref.locator, ctx);
        const projected = projectDocsToMarkdown(await dumpTargetGraph(ref, ctx));

        // Konfliktregel (SPEC §6.2): ohne aktuellen Pull kein Schreiben in
        // einen nicht-leeren Vault; bei zwischenzeitlicher externer
        // Änderung ist push ohne reconcile/Sync verboten.
        const lastPulled = ref.revision;
        if ((lastPulled === undefined && currentFiles.length > 0) || (lastPulled !== undefined && lastPulled !== currentRevision)) {
            const report: ConflictReport = {
                sourceRevision: currentRevision,
                lastPulledRevision: lastPulled,
                conflicts: diffVaultAgainstProjection(currentFiles, projected.files),
            };
            throw new ConnectorConflictError(
                lastPulled === undefined
                    ? 'Der Vault enthält bereits Notizen, wurde aber noch nie synchronisiert — erst synchronisieren, dann exportieren.'
                    : 'Der Vault wurde seit dem letzten Sync extern verändert — erst synchronisieren, dann exportieren.',
                report,
            );
        }

        let written = 0;
        const currentByPath = new Map(currentFiles.map(file => [file.path, file.content]));
        for (const file of projected.files) {
            if (currentByPath.get(file.path) === file.content) continue;
            const absolute = `${root}/${file.path}`;
            const dir = absolute.slice(0, absolute.lastIndexOf('/'));
            if (dir !== root) await fs.mkdir(dir);
            await fs.writeFile(absolute, file.content);
            written += 1;
            ctx.report({ done: written, total: projected.files.length, note: file.path });
        }

        const after = await readVaultFiles(fs, root);
        return {
            mode: 'direct',
            revision: await vaultRevision(after),
        };
    },

    async reconcile(ref: SourceRef, ctx: ConnectorContext): Promise<ConflictReport> {
        const { files: currentFiles, revision } = await readVault(ref.locator, ctx);
        const projected = projectDocsToMarkdown(await dumpTargetGraph(ref, ctx));
        return {
            sourceRevision: revision,
            lastPulledRevision: ref.revision,
            conflicts: diffVaultAgainstProjection(currentFiles, projected.files),
        };
    },
};
