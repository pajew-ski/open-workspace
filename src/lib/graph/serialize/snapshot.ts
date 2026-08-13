/**
 * Snapshot-Layout `data/graph/` (SPEC §8.1) — die Serialisierung des
 * Stores als Git-Working-Tree.
 *
 * Deterministisch: kanonische N-Quads pro Graph (RDFC-1.0-stabile Blank
 * Nodes, sortierte Zeilen) und ein Manifest ohne Zeitstempel. Zweimaliges
 * Schreiben desselben Zustands erzeugt byte-identische Dateien.
 *
 * Nicht persistiert werden:
 *  - `graph/vocab` — wird beim Start aus `ontology/ow.ttl` geladen
 *    (mitgelieferte Kopie, SPEC §3.2); eine zweite Kopie wäre doppelte
 *    Wahrheit.
 *  - `graph/<u>/inferred/*` — reproduzierbarer Reasoner-Output (SPEC §8.1).
 *  - `graph/acl` — verlässt den Store nie über generische Pfade (SPEC §3.3).
 *    Er wird trotzdem gesichert, aber bewusst NEBEN dem Manifest
 *    (`acl.nq`, `writeAclSnapshot`): Rechte müssen einen Neustart
 *    überleben, dürfen aber nie über einen manifest-getriebenen Pfad
 *    ausgeliefert oder zurückgelesen werden — weder als `bidirectional`-
 *    Restore eines kanonischen Graphen noch im Export eines Nutzers
 *    (M13, §17.4). Ein Git-Backup, dessen Zielverzeichnis `data/graph`
 *    selbst ist, committet die Datei als Teil des Arbeitsverzeichnisses
 *    mit — das ist in Ordnung: Ein Backup darf nach §17.4 ohnehin nur
 *    anlegen, wer `control` auf JEDEM enthaltenen Graphen hat.
 */

import type { NamedNode, Quad } from '@rdfjs/types';
import type { GraphStore } from '../store/types';
import type { FileSystemLike } from '@/lib/platform/runtime/types';
import { canonicalNQuads, hashCanonical } from './canonical';
import { parseRdf } from './io';
import { factory } from '../rdf';

/**
 * Version 2 seit dem Abschluss von SPEC §12.4: Der Workspace-Snapshot wird
 * vom Store-first-Schreibpfad erzeugt (inkl. Quelltreue-Termen). Ein
 * v1-Manifest markiert einen Stand, in dem die Dateien unter data/ noch
 * operative Quelle waren — der Bootstrap re-migriert dann einmalig aus dem
 * Dateibestand.
 *
 * Version 3 seit M15: Kalender und Chats sind Graph-Bürger. Ein
 * v2-Manifest kennt ihre Knoten noch nicht, obwohl die Dateien
 * (`data/calendar/*.json`, `data/chat/conversations.json`) den Bestand
 * tragen — der Bootstrap re-migriert deshalb einmalig aus dem
 * Dateibestand, genau wie beim Übergang v1 → v2. Das Datei-LAYOUT ist
 * über alle drei Versionen unverändert.
 */
export const SNAPSHOT_SCHEMA_VERSION = 3;
const COMPATIBLE_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1, 2, 3]);

export interface SnapshotManifest {
    schemaVersion: number;
    canonicalization: 'RDFC-1.0';
    instanceBase: string;
    graphs: Array<{ iri: string; file: string; quads: number; sha256: string }>;
}

export interface SnapshotReport {
    written: Array<{ file: string; quads: number }>;
    removedStale: string[];
}

/**
 * Graph-IRI → Dateiname. Der Default-Nutzer bekommt das flache Layout aus
 * SPEC §8.1; weitere Nutzer (M13) nisten unter `u/<id>/`.
 */
export function snapshotFileForGraph(graphIri: string, instanceBase: string): string | null {
    if (!graphIri.startsWith(`${instanceBase}graph/`)) return null;
    const rest = graphIri.slice(`${instanceBase}graph/`.length);
    if (rest === 'meta') return 'meta.nq';
    if (rest === 'vocab' || rest === 'acl' || rest === 'shapes') return null;
    const userMatch = rest.match(/^u\/([^/]+)\/(.+)$/);
    if (!userMatch) {
        const shared = rest.match(/^shared\/(.+)$/);
        if (shared) return `shared/${sanitizeFileSegment(shared[1])}.nq`;
        return null;
    }
    const [, userId, scope] = userMatch;
    const prefix = userId === 'default' ? '' : `u/${sanitizeFileSegment(userId)}/`;
    if (scope === 'workspace') return `${prefix}workspace.nq`;
    if (scope === 'public') return `${prefix}public.nq`;
    if (scope === 'presentation') return `${prefix}presentation.nq`;
    // Kausalmodelle (CAUSAL_LAYER_SPEC §5.1): Ein von Hand modellierter
    // DAG ist Handarbeit des Menschen und hat keine Quelle, aus der er
    // wiederherstellbar wäre — er MUSS in den Snapshot, sonst wäre er
    // nach dem nächsten Neustart weg. Ein Graph pro Modell, damit ein
    // Modell als Ganzes versioniert, verglichen und ersetzt werden kann.
    if (scope === 'causal-hypotheses') return `${prefix}causal-hypotheses.nq`;
    const causalMatch = scope.match(/^causal\/(.+)$/);
    if (causalMatch) return `${prefix}causal/${sanitizeFileSegment(causalMatch[1])}.nq`;
    const importMatch = scope.match(/^import\/(.+)$/);
    if (importMatch) return `${prefix}import/${sanitizeFileSegment(importMatch[1])}.nq`;
    if (scope.startsWith('inferred/')) return null;
    return null;
}

function sanitizeFileSegment(value: string): string {
    return decodeURIComponent(value).replace(/[^A-Za-z0-9._-]+/g, '-');
}

async function collect(iterable: AsyncIterable<Quad>): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const q of iterable) {
        quads.push(q);
    }
    return quads;
}

function joinPath(dir: string, file: string): string {
    return `${dir.replace(/\/$/, '')}/${file}`;
}

export interface WriteSnapshotOptions {
    /**
     * Filtert Quads aus dem Snapshot (true = behalten). Der git-backup-
     * Connector blendet damit seine EIGENE volatile Sync-Buchführung aus
     * (lastRun-Zeitstempel, Revision) — sonst wäre jedes Backup allein
     * wegen des vorherigen Backups „geändert" und die Historie voller
     * Rausch-Commits (dieselbe Kategorie, aus der §8.1 `inferred`
     * ausschließt). Der Live-Snapshot der App (data/graph) filtert nichts.
     */
    filterQuad?: (quad: Quad, graphIri: string) => boolean;
}

/**
 * Schreibt den Snapshot des Stores nach `dir`. Entfernt `.nq`-Dateien,
 * deren Graph nicht mehr existiert, damit der Working-Tree den Store
 * exakt spiegelt.
 */
export async function writeSnapshot(
    store: GraphStore,
    fs: FileSystemLike,
    dir: string,
    instanceBase: string,
    options: WriteSnapshotOptions = {},
): Promise<SnapshotReport> {
    const graphs = await store.graphs();
    const entries: SnapshotManifest['graphs'] = [];
    const written: SnapshotReport['written'] = [];

    await fs.mkdir(dir);
    for (const graph of graphs) {
        const file = snapshotFileForGraph(graph.value, instanceBase);
        if (!file) continue;
        let quads = await collect(store.dump(graph));
        if (options.filterQuad) {
            quads = quads.filter(quad => options.filterQuad!(quad, graph.value));
        }
        const canonical = await canonicalNQuads(quads);
        const target = joinPath(dir, file);
        const parent = target.slice(0, target.lastIndexOf('/'));
        if (parent !== dir.replace(/\/$/, '')) {
            await fs.mkdir(parent);
        }
        await fs.writeFile(target, canonical);
        entries.push({ iri: graph.value, file, quads: quads.length, sha256: await hashCanonical(canonical) });
        written.push({ file, quads: quads.length });
    }

    entries.sort((a, b) => (a.iri < b.iri ? -1 : 1));
    const manifest: SnapshotManifest = {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        canonicalization: 'RDFC-1.0',
        instanceBase,
        graphs: entries,
    };
    await fs.writeFile(joinPath(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const removedStale = await removeStaleFiles(fs, dir, new Set([...entries.map(e => e.file), ACL_FILE]));
    return { written, removedStale };
}

/**
 * Sicherung der Zugriffsregeln (M13). Bewusst eine eigene Funktion mit
 * eigener Datei und OHNE Manifest-Eintrag: Jeder manifest-getriebene Pfad
 * — der `bidirectional`-Restore kanonischer Graphen, der Nutzer-Export,
 * die Snapshot-Auslieferung eines Connectors — geht damit an den Rechten
 * vorbei. Nur der `push` eines Git-Backups, dessen Zielverzeichnis
 * `data/graph` selbst ist, nimmt sie als Datei des Arbeitsverzeichnisses
 * mit; das darf er, weil ein Backup `control` auf jedem enthaltenen
 * Graphen voraussetzt (§17.4).
 */
export const ACL_FILE = 'acl.nq';

export async function writeAclSnapshot(
    store: GraphStore,
    fs: FileSystemLike,
    dir: string,
    aclGraph: NamedNode,
): Promise<{ quads: number }> {
    const quads = await collect(store.dump(aclGraph));
    await fs.mkdir(dir);
    await fs.writeFile(joinPath(dir, ACL_FILE), await canonicalNQuads(quads));
    return { quads: quads.length };
}

/** Lädt `acl.nq` zurück in den Store. `null`, wenn es die Datei nicht gibt. */
export async function restoreAclSnapshot(
    store: GraphStore,
    fs: FileSystemLike,
    dir: string,
    aclGraph: NamedNode,
): Promise<{ quads: number } | null> {
    const path = joinPath(dir, ACL_FILE);
    if (!(await fs.exists(path))) return null;
    const quads = parseRdf(await fs.readFile(path), { format: 'application/n-quads' });
    const result = await store.load(quads, aclGraph, { replace: true });
    return { quads: result.added };
}

async function listNqFiles(fs: FileSystemLike, dir: string, prefix = ''): Promise<string[]> {
    if (!(await fs.exists(dir))) return [];
    const out: string[] = [];
    for (const name of await fs.readdir(dir)) {
        const rel = prefix ? `${prefix}/${name}` : name;
        const full = joinPath(dir, name);
        if (name.endsWith('.nq')) {
            out.push(rel);
        } else if (!name.includes('.')) {
            out.push(...(await listNqFiles(fs, full, rel)));
        }
    }
    return out;
}

async function removeStaleFiles(fs: FileSystemLike, dir: string, keep: ReadonlySet<string>): Promise<string[]> {
    const removed: string[] = [];
    for (const rel of await listNqFiles(fs, dir)) {
        if (!keep.has(rel)) {
            await fs.rm(joinPath(dir, rel));
            removed.push(rel);
        }
    }
    return removed;
}

export async function readManifest(fs: FileSystemLike, dir: string): Promise<SnapshotManifest | null> {
    const path = joinPath(dir, 'manifest.json');
    if (!(await fs.exists(path))) return null;
    const parsed: unknown = JSON.parse(await fs.readFile(path));
    if (
        typeof parsed !== 'object' || parsed === null ||
        !COMPATIBLE_SCHEMA_VERSIONS.has((parsed as SnapshotManifest).schemaVersion) ||
        !Array.isArray((parsed as SnapshotManifest).graphs)
    ) {
        throw new Error(`Ungültiges oder inkompatibles Snapshot-Manifest: ${path}`);
    }
    return parsed as SnapshotManifest;
}

export interface RestoreReport {
    graphs: Array<{ iri: string; quads: number }>;
}

/** Lädt einen Snapshot in den Store (Replace pro Graph, manifest-getrieben). */
export async function restoreSnapshot(
    store: GraphStore,
    fs: FileSystemLike,
    dir: string,
): Promise<RestoreReport | null> {
    const manifest = await readManifest(fs, dir);
    if (!manifest) return null;
    const report: RestoreReport = { graphs: [] };
    for (const entry of manifest.graphs) {
        const path = joinPath(dir, entry.file);
        if (!(await fs.exists(path))) {
            throw new Error(`Snapshot-Datei fehlt: ${path} (im Manifest gelistet)`);
        }
        const quads = parseRdf(await fs.readFile(path), { format: 'application/n-quads' });
        const graph: NamedNode = factory.namedNode(entry.iri);
        const result = await store.load(quads, graph, { replace: true });
        report.graphs.push({ iri: entry.iri, quads: result.added });
    }
    return report;
}
