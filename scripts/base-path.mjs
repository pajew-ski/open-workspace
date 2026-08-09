/**
 * Base-Path in einen fertigen Build einsetzen (SPEC §5.2, M12).
 *
 * Next backt `basePath` und `assetPrefix` in den Build: in den Server-Code,
 * in die Client-Bundles, in vorgerenderte Seiten und in die Manifeste. Der
 * Home-Assistant-Ingress-Pfad (`/api/hassio_ingress/<token>`) steht aber
 * erst zur Installationszeit fest. Deshalb baut das Container-Image EINMAL
 * mit dem Platzhalter `/__ow_base__` (`OW_BASE_PATH`), und dieser Schritt
 * ersetzt ihn beim Start durch den echten Pfad — oder durch nichts, wenn
 * die App an der Wurzel läuft (Runtime `server`).
 *
 * Damit bleibt es bei EINEM Image und EINEM Dockerfile für `server` und
 * `ha-addon` (Review-Blocker laut SPEC §5.2).
 *
 * Reines Node-ESM ohne Abhängigkeiten: das Runtime-Image hat kein bun.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Der Platzhalter, mit dem das Image gebaut wird. */
export const BASE_PATH_PLACEHOLDER = '/__ow_base__';

/** Datei, die den aktuell eingesetzten Wert festhält (im Build-Verzeichnis). */
export const BASE_PATH_MARKER = '.ow-base-path';

/**
 * Dateiendungen, die Next als Text ausliefert. Bewusst eine Erlaubnisliste:
 * Ein blinder Binär-Ersatz über WASM- oder Bilddateien wäre ein Datenschaden,
 * kein Feature.
 */
const TEXT_EXTENSIONS = new Set([
    '.js', '.mjs', '.cjs', '.json', '.html', '.txt', '.css', '.map',
    '.rsc', '.meta', '.body', '.webmanifest', '.xml',
]);

/** Verzeichnisse, die nie umgeschrieben werden (Nutzdaten, Abhängigkeiten). */
const SKIP_DIRECTORIES = new Set(['node_modules', 'data', '.git']);

/** Normalisierung wie in src/lib/platform/base-path.ts — eine Regel, zwei Laufzeiten. */
export function normalizeBasePath(value) {
    if (!value) return '';
    let result = String(value).trim();
    if (!result || result === '/') return '';
    if (!result.startsWith('/')) result = `/${result}`;
    while (result.endsWith('/')) result = result.slice(0, -1);
    if (result === BASE_PATH_PLACEHOLDER) return '';
    return result;
}

async function* walk(dir) {
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
        if (error && error.code === 'ENOENT') return;
        // Ein Ziel darf auch eine einzelne Datei sein (server.js).
        if (error && error.code === 'ENOTDIR') {
            if (TEXT_EXTENSIONS.has(path.extname(dir))) yield dir;
            return;
        }
        throw error;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRECTORIES.has(entry.name)) continue;
            yield* walk(full);
            continue;
        }
        if (!entry.isFile()) continue;
        if (!TEXT_EXTENSIONS.has(path.extname(entry.name))) continue;
        yield full;
    }
}

async function readMarker(root) {
    try {
        const raw = await fs.readFile(path.join(root, BASE_PATH_MARKER), 'utf-8');
        return raw.trim();
    } catch {
        return null;
    }
}

/**
 * Setzt `basePath` in einen gebauten Baum ein.
 *
 * @param {object} options
 * @param {string} options.root       Wurzel des Builds (im Image: /app).
 * @param {string} options.basePath   Zielpfad ('' = App liegt an der Wurzel).
 * @param {string[]} [options.targets] Unterverzeichnisse/Dateien relativ zu root.
 * @returns {Promise<{from: string, to: string, changedFiles: number, replacements: number}>}
 */
export async function applyBasePath({ root, basePath, targets }) {
    const to = normalizeBasePath(basePath);
    const marker = await readMarker(root);
    const from = marker === null ? BASE_PATH_PLACEHOLDER : marker;

    if (from === to) {
        return { from, to, changedFiles: 0, replacements: 0 };
    }
    if (from === '') {
        // Der Platzhalter ist weg — ein leerer String ist im Build nicht mehr
        // auffindbar. Ehrlich abbrechen statt halb umschreiben.
        throw new Error(
            `Der Build läuft bereits ohne Base-Path; "${to}" lässt sich nicht nachträglich setzen. `
            + 'Container neu starten (das Image bringt den Platzhalter mit).',
        );
    }

    const roots = (targets ?? ['.']).map(entry => path.resolve(root, entry));
    let changedFiles = 0;
    let replacements = 0;

    for (const target of roots) {
        for await (const file of walk(target)) {
            const content = await fs.readFile(file, 'utf-8');
            if (!content.includes(from)) continue;
            const occurrences = content.split(from).length - 1;
            await fs.writeFile(file, content.split(from).join(to), 'utf-8');
            changedFiles += 1;
            replacements += occurrences;
        }
    }

    await fs.writeFile(path.join(root, BASE_PATH_MARKER), `${to}\n`, 'utf-8');
    return { from, to, changedFiles, replacements };
}

/** Aktuell im Build eingesetzter Base-Path ('' oder Pfad), oder der Platzhalter. */
export async function currentBasePath(root) {
    const marker = await readMarker(root);
    return marker === null ? BASE_PATH_PLACEHOLDER : marker;
}
