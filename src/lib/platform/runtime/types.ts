/**
 * Runtime-Adapter (SPEC §5.2).
 *
 * Core-Code kennt ausschließlich diese Interfaces (Invariante 7): kein
 * `if (isBrowser)` außerhalb der Adapter. Die drei Runtimes heißen
 * `local`, `ha-addon`, `server` — „Standalone" wird nicht mehr als
 * Runtime-Bezeichnung verwendet.
 *
 * Stand des Ausbaus: implementiert ist der `server`-Adapter (Node).
 * `local` (OPFS/Worker) und `ha-addon` folgen mit M6/M12 — es gibt
 * bewusst keine Platzhalter-Implementierungen (keine Attrappen).
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
}

export interface GitProvider {
    /** isomorphic-git (local) oder Prozess-git (ha-addon/server) — ab M6. */
    readonly kind: 'isomorphic-git' | 'process-git';
}

export interface Identity {
    userId: string;
    groups: string[];
}

export interface AuthProvider {
    identity(): Promise<Identity>;
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
