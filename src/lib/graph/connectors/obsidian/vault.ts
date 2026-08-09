/**
 * Vault-Zugriff des obsidian-vault-Connectors: Pfad-Politik, rekursives
 * Einlesen, Inhalts-Revision.
 *
 * Pfad-Politik (analog zur SSRF-Politik des Connector-Fetch, http.ts):
 * Ein Vault-Pfad ist Nutzereingabe und der Connector läuft serverseitig —
 * ohne Schranke wäre jeder lesbare Server-Ordner in den Graphen
 * importierbar. Erlaubt sind deshalb nur Pfade unter `data/vaults/`
 * (relativ zum Arbeitsverzeichnis) sowie unter explizit freigegebenen
 * Wurzeln aus `OW_VAULT_ROOTS` (mit `:` getrennte absolute Pfade).
 * Die Prüfung ist eine normalisierte Präfix-Prüfung; Symlinks werden
 * nicht aufgelöst (FileSystemLike kennt kein realpath) — wer eine Wurzel
 * freigibt, gibt frei, was darunter erreichbar ist.
 */

import type { FileSystemLike } from '@/lib/platform/runtime/types';
import { sha256Hex } from '../quads';

/** Standard-Wurzel für Vaults, relativ zum Arbeitsverzeichnis. */
export const DEFAULT_VAULT_ROOT = 'data/vaults';

/**
 * POSIX-Normalisierung ohne Dateisystemzugriff: löst `.`/`..`-Segmente
 * auf und lehnt Pfade ab, die über ihre Wurzel hinausklettern.
 */
export function normalizeVaultPath(input: string): string {
    const trimmed = input.trim().replace(/\\/g, '/');
    if (trimmed === '') {
        throw new Error('Vault-Pfad ist leer.');
    }
    const absolute = trimmed.startsWith('/');
    const segments: string[] = [];
    for (const segment of trimmed.split('/')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') {
            if (segments.length === 0) {
                throw new Error(`Vault-Pfad "${input}" klettert über seine Wurzel hinaus.`);
            }
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    if (segments.length === 0) {
        throw new Error(`Vault-Pfad "${input}" bezeichnet keine Vault-Wurzel.`);
    }
    return (absolute ? '/' : '') + segments.join('/');
}

function allowedRoots(): string[] {
    const roots: string[] = [];
    if (typeof process !== 'undefined') {
        const cwd = typeof process.cwd === 'function' ? process.cwd().replace(/\\/g, '/') : '';
        if (cwd) roots.push(normalizeVaultPath(`${cwd}/${DEFAULT_VAULT_ROOT}`));
        for (const entry of (process.env.OW_VAULT_ROOTS ?? '').split(':')) {
            if (entry.trim() !== '') roots.push(normalizeVaultPath(entry));
        }
    }
    return roots;
}

/**
 * Löst einen konfigurierten Vault-Pfad zur geprüften absoluten Wurzel auf.
 * Relative Pfade gelten relativ zum Arbeitsverzeichnis.
 */
export function resolveVaultRoot(locator: string): string {
    let normalized = normalizeVaultPath(locator);
    if (!normalized.startsWith('/') && typeof process !== 'undefined' && typeof process.cwd === 'function') {
        normalized = normalizeVaultPath(`${process.cwd().replace(/\\/g, '/')}/${normalized}`);
    }
    const roots = allowedRoots();
    const allowed = roots.some(root => normalized === root || normalized.startsWith(`${root}/`));
    if (!allowed) {
        throw new Error(
            `Vault-Pfad "${locator}" liegt außerhalb der erlaubten Wurzeln und ist blockiert. ` +
            `Erlaubt: ${DEFAULT_VAULT_ROOT}/… oder eine Wurzel aus OW_VAULT_ROOTS.`,
        );
    }
    return normalized;
}

export interface VaultFile {
    /** Vault-relativer Pfad, `/`-getrennt. */
    path: string;
    content: string;
}

/** Versteckte Einträge (u. a. `.obsidian`, `.trash`) werden übergangen. */
function isHiddenEntry(name: string): boolean {
    return name.startsWith('.');
}

/**
 * Liest alle Markdown-Dateien eines Vaults, deterministisch sortiert.
 * Nicht lesbare Einzeldateien meldet der Aufrufer über `onError` als
 * Quarantäne — ein kaputter Eintrag bricht den Lauf nicht ab.
 */
export async function readVaultFiles(
    files: FileSystemLike,
    root: string,
    onError?: (path: string, reason: string) => void,
): Promise<VaultFile[]> {
    const collected: VaultFile[] = [];
    const walk = async (dir: string, relative: string): Promise<void> => {
        const entries = (await files.readdir(dir)).sort();
        for (const entry of entries) {
            if (isHiddenEntry(entry)) continue;
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
            if (!/\.md$/i.test(entry)) continue;
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
 * Inhalts-Revision des Vaults: SHA-256 über die sortierte Liste
 * `pfad<TAB>sha256(inhalt)`. Identischer Bestand ⇒ identische Revision ⇒
 * No-Op beim Sync (SPEC §6.2).
 */
export async function vaultRevision(vaultFiles: VaultFile[]): Promise<string> {
    const lines: string[] = [];
    for (const file of vaultFiles) {
        lines.push(`${file.path}\t${await sha256Hex(file.content)}`);
    }
    return `sha256:${await sha256Hex(lines.join('\n'))}`;
}
