/**
 * Runtime-Adapter (SPEC §5.2).
 *
 * Core-Code kennt ausschließlich diese Interfaces (Invariante 7): kein
 * `if (isBrowser)` außerhalb der Adapter. Die drei Runtimes heißen
 * `local`, `ha-addon`, `server` — „Standalone" wird nicht mehr als
 * Runtime-Bezeichnung verwendet.
 *
 * Stand des Ausbaus (M12): Alle drei Runtimes haben ihre Bindungen.
 * `server` und `ha-addon` teilen eine Implementierung (server.ts —
 * node:fs, Prozess-git, Identität aus der Anfrage), weil sie dasselbe
 * Container-Image sind; welche gerade läuft, sagt `OW_RUNTIME`. `local`
 * (local.ts) bindet den Store im Web Worker (worker/), Dateien im OPFS
 * (opfs.ts) und Git über genau dieses Dateisystem (isomorphic-git.ts).
 * Es gibt bewusst keine Platzhalter-Implementierungen (keine Attrappen);
 * die Anwendung selbst läuft weiterhin gegen das Backend — die Umstellung
 * der Graph-Oberflächen auf den Browser-Store ist kein Teil von M12.
 */

import type { GraphStore } from '@/lib/graph/store/types';

export type RuntimeId = 'local' | 'ha-addon' | 'server';

/** Minimale Dateisystem-Abstraktion: OPFS-Wrapper oder node:fs/promises. */
export interface FileSystemLike {
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    exists(path: string): Promise<boolean>;
    rm(path: string): Promise<void>;
    /**
     * Unterscheidet Datei und Verzeichnis; wirft bei fehlendem Pfad.
     * `size`/`mtimeMs` sind optionale Frische-Signale (M6): isomorphic-git
     * braucht sie, um Index-Caches zu invalidieren — ein Backing, das sie
     * weglässt, würde Änderungen bei identischen Stats übersehen.
     */
    stat(path: string): Promise<{ isDirectory: boolean; size?: number; mtimeMs?: number }>;
    /**
     * Hängt an eine Datei an, ohne sie vorher zu lesen. Optional, weil
     * nicht jedes Backing das billig kann (OPFS braucht dafür einen
     * Schreib-Handle mit Seek). Wer sie nicht hat, wird über Lesen +
     * Schreiben bedient — korrekt, nur teurer. Gebraucht vom
     * Beobachtungs-Speicher, der ausschließlich anhängt.
     */
    appendFile?(path: string, content: string): Promise<void>;
}

/**
 * Binär-Erweiterung von FileSystemLike (M6): Git-Objekte sind komprimierte
 * Binärdaten — die String-API reicht dafür nicht. node:fs, das
 * Memory-Double und der OPFS-Wrapper (M12) implementieren beide Ebenen.
 */
export interface BinaryFileSystemLike extends FileSystemLike {
    readBytes(path: string): Promise<Uint8Array>;
    writeBytes(path: string, data: Uint8Array): Promise<void>;
}

export interface GitAuthor {
    name: string;
    email: string;
}

export interface GitChange {
    path: string;
    state: 'added' | 'modified' | 'deleted' | 'untracked';
}

export interface GitCommitResult {
    /** HEAD nach dem Aufruf (auch wenn nichts committet wurde). */
    sha: string | null;
    /** false, wenn der Working Tree sauber war (kein neuer Commit). */
    committed: boolean;
}

/**
 * Git-Schicht des Git-Syncs (SPEC §8, M6) — EINE Implementierung pro
 * Bindung, drei Runtimes: Prozess-git (`server`/`ha-addon`, dasselbe
 * Image) und isomorphic-git über FileSystemLike (`local`; im Browser mit
 * OPFS-Backing, Push/Pull dort nur über CORS-fähige Hosts — SPEC §8.3).
 */
export interface GitProvider {
    readonly kind: 'isomorphic-git' | 'process-git';
    isRepo(dir: string): Promise<boolean>;
    /** Initialisiert ein Repository (idempotent), Default-Branch `main`. */
    init(dir: string): Promise<void>;
    /** SHA des HEAD-Commits; null ohne Commits oder ohne Repository. */
    head(dir: string): Promise<string | null>;
    /** Working-Tree-Änderungen relativ zu HEAD. */
    status(dir: string): Promise<GitChange[]>;
    /** `add -A` + Commit; committed=false bei sauberem Working Tree. */
    commitAll(dir: string, message: string, author: GitAuthor): Promise<GitCommitResult>;
    /** Geänderte Pfade zwischen zwei Commits. */
    changedFiles(dir: string, fromSha: string, toSha: string): Promise<string[]>;
    /** Menschlich lesbarer, zeilenbasierter Diff zwischen zwei Commits. */
    diff(dir: string, fromSha: string, toSha: string): Promise<string>;
    /**
     * Remote-Sync (optional — die Bindung kann ihn nicht immer leisten,
     * z. B. isomorphic-git ohne HTTP-Client). `pull` ist fast-forward-only:
     * ein divergierter Verlauf ist ein ehrlicher Fehler, kein Auto-Merge.
     */
    push?(dir: string, remoteUrl: string, branch: string): Promise<void>;
    pull?(dir: string, remoteUrl: string, branch: string): Promise<void>;
}

export interface Identity {
    userId: string;
    groups: string[];
}

export interface AuthProvider {
    /**
     * Identität der laufenden Anfrage. Der Kontext ist optional, weil
     * Hintergrundpfade (Start, Migration, Cron) keine Anfrage haben — sie
     * bekommen den Einzelnutzer der Installation (M12, SPEC §5.2).
     */
    identity(context?: { headers?: Headers }): Promise<Identity>;
}

export interface SecretStore {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
}

export interface RuntimeCapabilities {
    sparqlEndpoint: boolean;
    mcpServer: boolean;
    federationOutbound: boolean;
    federationInbound: boolean;
    multiUser: boolean;
    reasoningTier: 'rl' | 'rl+dl';
}

export interface RuntimeAdapter {
    readonly id: RuntimeId;
    store(): Promise<GraphStore>;
    files(): FileSystemLike;
    git(): GitProvider;
    auth(): AuthProvider;
    secrets(): SecretStore;
    readonly capabilities: RuntimeCapabilities;
}
