/**
 * Umfang eines Nutzer-Exports (SPEC §17.4, M13).
 *
 * „Der Export eines Nutzers enthält nur dessen Dataset." Diese eine
 * Funktion beantwortet, welche Verzeichnisse das sind — getrennt von der
 * Route, damit die Regel testbar ist und nicht erst über einen
 * HTTP-Aufruf sichtbar wird.
 */

import path from 'node:path';
import { workspaceFilePathsFor } from './files';

/**
 * Instanzweite Bestände: noch keine Graph-Bürger (Chats, Termine,
 * Einstellungen, AI-Konfiguration) und deshalb nicht nutzerskaliert. Sie
 * gehören der Installation und gehen nur an Verwalter.
 */
export const INSTANCE_EXPORT_DIRS = ['settings', 'chat', 'calendar', 'ai', 'agents', 'connections'] as const;

export interface ExportScope {
    /** Verzeichnisse, aus denen der Export liest. */
    directories: string[];
    /** Menschenlesbare Aussage darüber, was NICHT enthalten ist. */
    description: string;
}

export function exportScopeFor(
    userId: string,
    isAdmin: boolean,
    dataDir: string = path.join(process.cwd(), 'data'),
): ExportScope {
    const paths = workspaceFilePathsFor(userId, dataDir);
    return {
        directories: [
            paths.docsDir,
            path.dirname(paths.tasksFile),
            paths.canvasDir,
            ...(isAdmin ? INSTANCE_EXPORT_DIRS.map(dir => path.join(dataDir, dir)) : []),
        ],
        description: isAdmin
            ? 'Eigener Arbeitsbereich plus instanzweite Bestände (Verwalter).'
            : 'Nur der eigene Arbeitsbereich. Instanzweite Bestände und fremde Nutzergraphen sind nicht enthalten.',
    };
}
