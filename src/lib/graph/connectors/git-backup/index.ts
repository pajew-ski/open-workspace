/**
 * `git-backup`-Connector (SPEC §6.3, §8 — Meilenstein M6): das eigene
 * Backup-Repo über den EINEN Connector-Vertrag (Invariante 5) — Git-Sync
 * ist kein separates Feature, sondern die Serialisierung des Stores.
 *
 * Zwei Modi (SPEC §8.2), EIN Codepfad:
 *  - `backup`: Einbahnstraße Store → Git. `push` schreibt den
 *    deterministischen Snapshot (RDFC-1.0, minimale lesbare Diffs) in den
 *    Working Tree und committet; der Store bleibt kanonisch. Kein
 *    Rücklesen — `pull` lehnt ehrlich ab. Externe Änderungen im Repo
 *    werden beim nächsten Backup überschrieben (der Working Tree ist ein
 *    Spiegel des Stores).
 *  - `bidirectional`: zusätzlich liest `pull` das Repo zurück —
 *    Snapshot-Dateien laut Manifest in ihre kanonischen Graphen
 *    (Restore, Runner-seitig in EINER Transaktion), alle übrigen
 *    RDF-Dateien (.ttl/.nq/…) in den Import-Graphen dieses Connectors.
 *    `push` folgt hier der Konfliktregel §6.2: weicht der Repo-Inhalt vom
 *    Stand des letzten Sync ab, wird nichts geschrieben.
 *
 * Revision = Inhalts-Hash über Manifest + RDF-Dateien (wie beim
 * obsidian-vault): unverändertes Repo ⇒ No-Op; auch unkommittierte
 * externe Edits werden erkannt. Git liefert Historie und Transport
 * (Commit, optional Push/Pull zu einem Remote), die Bindung kommt aus
 * der Runtime (SPEC §5.2): Prozess-git auf `server`/`ha-addon`,
 * isomorphic-git auf `local`.
 *
 * Pfad-Politik analog zum Vault (M4): nur unter `data/` bzw. Wurzeln aus
 * `OW_GIT_ROOTS`. `data/graph` (der Live-Snapshot, SPEC §8.1) ist das
 * natürliche Ziel für den Modus `backup`; für `bidirectional` empfiehlt
 * sich ein eigenes Verzeichnis (z. B. `data/backup`), weil der
 * Live-Snapshot nach jeder Mutation neu geschrieben wird und dann vor
 * jedem Export ein Sync fällig ist.
 */

import type { Quad } from '@rdfjs/types';
import { z } from 'zod';
import type { FileSystemLike, GitProvider } from '@/lib/platform/runtime/types';
import {
    ConnectorConflictError,
    type ConflictReport,
    type Connector,
    type ConnectorContext,
    type SourceRef,
    type WriteReceipt,
} from '../types';
import { isRdfPath, parseRdfLenient, relabelBlankNodes, sha256Hex } from '../quads';
import { normalizeVaultPath } from '../obsidian/vault';
import { syncRunIri } from '../registry';
import { readManifest, snapshotFileForGraph, writeSnapshot } from '../../serialize/snapshot';
import { factory, namedNode } from '../../rdf';
import { DCTERMS, OW } from '../../vocab';

const configSchema = z.object({
    /** Working-Tree-Pfad: unter data/ oder einer Wurzel aus OW_GIT_ROOTS. */
    path: z.string().min(1, 'Repo-Pfad ist erforderlich'),
    mode: z.enum(['backup', 'bidirectional']),
    /** Optionales Remote (URL); ohne Remote bleibt der Sync lokal. */
    remote: z.string().url().optional(),
    branch: z.string().regex(/^[\w][\w./-]*$/, 'Ungültiger Branch-Name').default('main'),
});

export type GitBackupConfig = z.infer<typeof configSchema>;

/** Standard-Wurzel: der data/-Baum der Installation. */
export const DEFAULT_GIT_ROOT = 'data';

const BACKUP_AUTHOR = { name: 'Open Workspace', email: 'graph-backup@open-workspace.local' };

function allowedRoots(): string[] {
    const roots: string[] = [];
    if (typeof process !== 'undefined') {
        const cwd = typeof process.cwd === 'function' ? process.cwd().replace(/\\/g, '/') : '';
        if (cwd) roots.push(normalizeVaultPath(`${cwd}/${DEFAULT_GIT_ROOT}`));
        for (const entry of (process.env.OW_GIT_ROOTS ?? '').split(':')) {
            if (entry.trim() !== '') roots.push(normalizeVaultPath(entry));
        }
    }
    return roots;
}

/** Löst den konfigurierten Repo-Pfad zur geprüften absoluten Wurzel auf. */
export function resolveBackupRoot(locatorPath: string): string {
    let normalized = normalizeVaultPath(locatorPath);
    if (!normalized.startsWith('/') && typeof process !== 'undefined' && typeof process.cwd === 'function') {
        normalized = normalizeVaultPath(`${process.cwd().replace(/\\/g, '/')}/${normalized}`);
    }
    const allowed = allowedRoots().some(root => normalized === root || normalized.startsWith(`${root}/`));
    if (!allowed) {
        throw new Error(
            `Repo-Pfad "${locatorPath}" liegt außerhalb der erlaubten Wurzeln und ist blockiert. ` +
            `Erlaubt: ${DEFAULT_GIT_ROOT}/… oder eine Wurzel aus OW_GIT_ROOTS.`,
        );
    }
    return normalized;
}

function requireFiles(ctx: ConnectorContext): FileSystemLike {
    if (!ctx.files) {
        throw new Error('Diese Runtime stellt keinen Dateizugriff bereit — der git-backup-Connector braucht ihn.');
    }
    return ctx.files;
}

function requireGit(ctx: ConnectorContext): GitProvider {
    const git = ctx.runtime?.git();
    if (!git) {
        throw new Error('Diese Runtime stellt keine Git-Bindung bereit — der git-backup-Connector braucht sie (SPEC §5.2).');
    }
    return git;
}

function parseLocator(locator: string): GitBackupConfig {
    const queryIndex = locator.indexOf('?');
    const path = queryIndex === -1 ? locator : locator.slice(0, queryIndex);
    const params = new URLSearchParams(queryIndex === -1 ? '' : locator.slice(queryIndex + 1));
    return configSchema.parse({
        path,
        mode: params.get('mode') ?? 'bidirectional',
        remote: params.get('remote') ?? undefined,
        branch: params.get('branch') ?? 'main',
    });
}

interface RepoFile {
    /** Repo-relativer Pfad, `/`-getrennt. */
    path: string;
    content: string;
}

/** Liest Manifest + alle RDF-Dateien des Working Trees (ohne .git/…). */
async function readRepoFiles(
    files: FileSystemLike,
    root: string,
    onError?: (path: string, reason: string) => void,
): Promise<RepoFile[]> {
    const collected: RepoFile[] = [];
    const walk = async (dir: string, relative: string): Promise<void> => {
        const entries = (await files.readdir(dir)).sort();
        for (const entry of entries) {
            if (entry.startsWith('.')) continue;
            const absolute = `${dir}/${entry}`;
            const relativePath = relative === '' ? entry : `${relative}/${entry}`;
            let isDirectory: boolean;
            try {
                isDirectory = (await files.stat(absolute)).isDirectory;
            } catch (error) {
                onError?.(relativePath, error instanceof Error ? error.message : String(error));
                continue;
            }
            if (isDirectory) {
                await walk(absolute, relativePath);
                continue;
            }
            if (relativePath !== 'manifest.json' && !isRdfPath(relativePath)) continue;
            try {
                collected.push({ path: relativePath, content: await files.readFile(absolute) });
            } catch (error) {
                onError?.(relativePath, error instanceof Error ? error.message : String(error));
            }
        }
    };
    await walk(root, '');
    collected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return collected;
}

/**
 * Inhalts-Revision des Repos: SHA-256 über die sortierte Liste
 * `pfad<TAB>sha256(inhalt)` — identischer Bestand ⇒ identische Revision ⇒
 * No-Op beim Sync (SPEC §6.2). Erkennt auch unkommittierte Edits.
 */
export async function backupRevision(repoFiles: RepoFile[]): Promise<string> {
    const lines: string[] = [];
    for (const file of repoFiles) {
        lines.push(`${file.path}\t${await sha256Hex(file.content)}`);
    }
    return `sha256:${await sha256Hex(lines.join('\n'))}`;
}

async function requireExistingRepoDir(files: FileSystemLike, config: GitBackupConfig): Promise<string> {
    const root = resolveBackupRoot(config.path);
    if (!(await files.exists(root))) {
        throw new Error(
            `Backup-Verzeichnis "${config.path}" existiert nicht — lege es an oder erstelle zuerst ein Backup (Exportieren).`,
        );
    }
    return root;
}

/**
 * Ein Backup-Ziel muss sein EIGENES Repository sein (Issue #32).
 *
 * Der Weg, der ohne diese Prüfung offensteht, ist kein hypothetischer:
 * `isRepo()` fragt Git, ob der Pfad in einem Working Tree liegt — und für
 * jedes Verzeichnis unter einem Checkout ist die Antwort ja, wegen des
 * UMGEBENDEN Repos. `push` überspringt dann `init()`, und `commitAll()`
 * legt den Graphen samt `acl.nq` als Commit im fremden Repo ab. Steht
 * dessen Remote auf einem öffentlichen `origin`, ist der Rest ein
 * automatisierter Lauf ohne Rückfrage.
 *
 * Die Grenze ist deshalb nicht „ist da ein Repo", sondern „ist das Repo
 * dieses Verzeichnis": ein eigenes `.git` am Ziel. Ein noch leeres
 * Verzeichnis außerhalb jedes Checkouts bleibt erlaubt — `push` legt dort
 * beim ersten Lauf sein Repo an.
 */
async function assertOwnRepo(files: FileSystemLike, git: GitProvider, root: string, locatorPath: string): Promise<void> {
    if (!(await git.isRepo(root))) return;
    if (await files.exists(`${root}/.git`)) return;
    throw new Error(
        `Backup-Ziel "${locatorPath}" liegt INNERHALB eines fremden Git-Repositories und ist blockiert: `
        + 'ein Backup dorthin committet den Graphen samt Zugriffsregeln in dieses Repo, nicht in ein eigenes. '
        + 'Wähle ein Ziel außerhalb (Wurzel über OW_GIT_ROOTS freigeben) oder mache das Verzeichnis mit '
        + '`git init` zu einem eigenen Repository.',
    );
}

export const gitBackupConnector: Connector<GitBackupConfig> = {
    kind: 'git-backup',
    mode: 'materialize',
    capabilities: { read: true, write: true, watch: false, lossyExport: false, restoresCanonicalGraphs: true },
    label: 'Git-Backup',
    description: 'Das eigene Backup-Repo (SPEC §8): Backup schreibt den deterministischen Graph-Snapshot als Commit (minimale, lesbare Diffs); im Modus „bidirectional" fließen externe Edits an .nq-/.ttl-Dateien beim Sync zurück in den Store.',

    configSchema: () => z.toJSONSchema(configSchema) as Record<string, unknown>,
    parseConfig: input => {
        const parsed = configSchema.parse(input);
        normalizeVaultPath(parsed.path);
        return parsed;
    },

    locatorFor: config => {
        const params = new URLSearchParams();
        params.set('branch', config.branch);
        params.set('mode', config.mode);
        if (config.remote) params.set('remote', config.remote);
        return `${normalizeVaultPath(config.path)}?${params.toString()}`;
    },
    configFromLocator: parseLocator,

    async probe(config, ctx): Promise<SourceRef> {
        const files = requireFiles(ctx);
        const root = await requireExistingRepoDir(files, config);
        await assertOwnRepo(files, requireGit(ctx), root, config.path);
        const repoFiles = await readRepoFiles(files, root);
        return {
            id: '',
            kind: this.kind,
            locator: this.locatorFor(config),
            revision: await backupRevision(repoFiles),
            fetchedAt: new Date().toISOString(),
        };
    },

    async *pull(ref: SourceRef, ctx: ConnectorContext): AsyncIterable<Quad> {
        const config = parseLocator(ref.locator);
        if (config.mode === 'backup') {
            throw new Error(
                'Modus „backup" ist eine Einbahnstraße Store → Git und liest nicht zurück — stelle auf „bidirectional" um, wenn externe Edits einfließen sollen.',
            );
        }
        const files = requireFiles(ctx);
        const root = await requireExistingRepoDir(files, config);

        // Remote zuerst holen (ff-only) — ein divergierter Verlauf ist ein
        // ehrlicher Infrastrukturfehler, kein Auto-Merge.
        if (config.remote) {
            const git = requireGit(ctx);
            if (!git.pull) {
                throw new Error('Diese Git-Bindung unterstützt kein Remote-Pull (Browser ohne CORS-fähigen Host, SPEC §8.3).');
            }
            await git.pull(root, config.remote, config.branch);
        }

        const repoFiles = await readRepoFiles(files, root, (path, reason) => ctx.quarantine({ source: path, reason }));
        const manifest = await readManifest(files, root).catch(error => {
            ctx.quarantine({ source: 'manifest.json', reason: error instanceof Error ? error.message : String(error) });
            return null;
        });

        // Snapshot-Dateien laut Manifest → Restore in kanonische Graphen,
        // aber nur, wenn das Manifest die KANONISCHE Abbildung behauptet
        // (snapshotFileForGraph). acl/vocab/shapes/inferred sind nie dabei;
        // ein Manifest einer fremden Instanz-Base fällt komplett durch und
        // seine Dateien landen als fremde Quelle im Import-Graphen.
        const restoreTargets = new Map<string, string>();
        for (const entry of manifest?.graphs ?? []) {
            if (snapshotFileForGraph(entry.iri, ctx.iri.instanceBase) === entry.file) {
                restoreTargets.set(entry.file, entry.iri);
            } else {
                ctx.quarantine({
                    source: entry.file,
                    reason: `Manifest-Eintrag ist nicht die kanonische Snapshot-Abbildung von <${entry.iri}> — Datei wird als fremde Quelle importiert, nicht wiederhergestellt.`,
                });
            }
        }

        let done = 0;
        for (const file of repoFiles) {
            if (file.path === 'manifest.json') continue;
            const targetGraph = restoreTargets.get(file.path);
            const parsed = parseRdfLenient(file.content, { source: file.path, path: file.path });
            for (const entry of parsed.quarantined) {
                ctx.quarantine(entry);
            }
            if (targetGraph) {
                // Restore: Graph-Komponente erzwingen — die Datei IST die
                // Serialisierung genau dieses Graphen; abweichende
                // Graph-Angaben einzelner Zeilen werden nicht zum
                // Seitenkanal in andere Graphen.
                const graphTerm = namedNode(targetGraph);
                for (const quad of parsed.quads) {
                    yield factory.quad(quad.subject, quad.predicate, quad.object, graphTerm);
                }
            } else {
                // Fremde RDF-Datei im Repo → Import-Graph dieses Connectors.
                yield* relabelBlankNodes(parsed.quads, file.path.replace(/[^A-Za-z0-9]+/g, '_'));
            }
            done += 1;
            ctx.report({ done, total: repoFiles.length, note: file.path });
        }
    },

    async push(ref: SourceRef, _delta, ctx): Promise<WriteReceipt> {
        const config = parseLocator(ref.locator);
        const files = requireFiles(ctx);
        const git = requireGit(ctx);
        const root = resolveBackupRoot(config.path);

        const existed = await files.exists(root);
        // Vor dem ersten Byte: das Ziel darf kein fremder Working Tree sein.
        if (existed) await assertOwnRepo(files, git, root, config.path);
        if (existed && config.mode === 'bidirectional') {
            // Konfliktregel §6.2: weicht der Repo-Inhalt vom Stand des
            // letzten Sync ab, wird nichts geschrieben. (Im Modus „backup"
            // ist der Working Tree ein reiner Spiegel des Stores — dort
            // gibt es keinen fremden Stand, den ein Backup verlieren könnte.)
            const repoFiles = await readRepoFiles(files, root);
            if (repoFiles.length > 0) {
                const currentRevision = await backupRevision(repoFiles);
                if (ref.revision === undefined || ref.revision !== currentRevision) {
                    const gitStatus = (await git.isRepo(root)) ? await git.status(root) : [];
                    const report: ConflictReport = {
                        sourceRevision: currentRevision,
                        lastPulledRevision: ref.revision,
                        conflicts: gitStatus.length > 0
                            ? gitStatus.map(change => ({ path: change.path, reason: `${change.state} im Working Tree` }))
                            : [{ path: config.path, reason: 'Repo-Inhalt weicht vom Stand des letzten Sync ab.' }],
                    };
                    throw new ConnectorConflictError(
                        ref.revision === undefined
                            ? 'Das Repo wurde noch nie synchronisiert — erst synchronisieren, dann exportieren.'
                            : 'Das Repo wurde seit dem letzten Sync verändert — erst synchronisieren, dann exportieren.',
                        report,
                    );
                }
            }
        }

        await files.mkdir(root);
        // Snapshot in den Working Tree (deterministisch, RDFC-1.0 — die
        // Grundlage der minimalen Diffs, SPEC §8.1). Die EIGENE volatile
        // Sync-Buchführung (Lauf-Knoten, Revision, Zustand) bleibt draußen:
        // sie ändert sich bei jedem Lauf und würde jede Historie mit
        // Rausch-Commits fluten; nach einem Restore setzt der Runner sie
        // ohnehin frisch. Die stabile Identität der Instanz (Name, Art,
        // Locator, created) wird mitgesichert.
        const selfIri = ctx.iri.entity('connector', ref.id);
        const selfRunIri = syncRunIri(ctx.iri, ref.id);
        const volatileSelf = new Set<string>([OW.syncState, OW.revision, DCTERMS.modified]);
        await writeSnapshot(ctx.store, files, root, ctx.iri.instanceBase, {
            filterQuad: quad => {
                if (quad.subject.termType !== 'NamedNode') return true;
                if (quad.subject.value === selfRunIri) return false;
                if (quad.subject.value === selfIri && volatileSelf.has(quad.predicate.value)) return false;
                return true;
            },
        });
        if (!(await git.isRepo(root))) {
            await git.init(root);
        }
        const commit = await git.commitAll(root, `Graph-Backup ${new Date().toISOString()}`, BACKUP_AUTHOR);

        if (config.remote) {
            if (!git.push) {
                throw new Error(
                    'Diese Git-Bindung unterstützt kein Remote-Push (Browser ohne CORS-fähigen Host, SPEC §8.3) — der Commit liegt lokal vor.',
                );
            }
            try {
                await git.push(root, config.remote, config.branch);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(`Commit lokal erstellt (${commit.sha ?? 'ohne Änderung'}), aber Push zum Remote fehlgeschlagen: ${message}`);
            }
        }

        const repoFiles = await readRepoFiles(files, root);
        return {
            mode: 'direct',
            revision: await backupRevision(repoFiles),
        };
    },

    async reconcile(ref: SourceRef, ctx: ConnectorContext): Promise<ConflictReport> {
        const config = parseLocator(ref.locator);
        const files = requireFiles(ctx);
        const root = await requireExistingRepoDir(files, config);
        const repoFiles = await readRepoFiles(files, root);
        const currentRevision = await backupRevision(repoFiles);
        const git = requireGit(ctx);
        const gitStatus = (await git.isRepo(root)) ? await git.status(root) : [];
        return {
            sourceRevision: currentRevision,
            lastPulledRevision: ref.revision,
            conflicts: currentRevision === ref.revision
                ? []
                : gitStatus.length > 0
                    ? gitStatus.map(change => ({ path: change.path, reason: `${change.state} im Working Tree` }))
                    : [{ path: config.path, reason: 'Repo-Inhalt weicht vom Stand des letzten Sync ab.' }],
        };
    },
};
