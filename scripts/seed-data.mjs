#!/usr/bin/env node
/**
 * Saat `seed/` → `data/` (Issue #32).
 *
 * Zwei Bestände, die vorher einer waren:
 *
 *  - `seed/` ist Auslieferung. Es liegt im Repo, im Image und ist für
 *    jede Installation gleich: Onboarding-Dokumente, die Beispiel-Pinnwand,
 *    das Start-Dashboard, ein Beispiel-Werkzeug.
 *  - `data/` ist der Bestand EINER Installation. Es liegt in keinem Repo
 *    (`.gitignore`: `/data/`) und in keinem Image, sondern im Volume bzw.
 *    im Arbeitsverzeichnis des Betreibers.
 *
 * Der Saat-Schritt ist deshalb additiv und nie zerstörend: kopiert wird
 * ausschließlich, was am Ziel FEHLT. Eine gelöschte Onboarding-Datei kommt
 * damit beim nächsten Start zurück — das ist der Preis dafür, dass ein
 * bearbeitetes Dokument nie überschrieben wird. Wer die Saat dauerhaft los
 * sein will, leert die Datei statt sie zu entfernen.
 *
 * Aufruf: `node scripts/seed-data.mjs [zielverzeichnis]`
 * (ohne Argument: `<cwd>/data`). Eingebunden in `bun run dev`/`start` und
 * in scripts/start.mjs, damit kein Startweg ohne Saat existiert.
 */

import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** Auslieferungsbestand relativ zur Repo-/Image-Wurzel. */
export const SEED_DIR = 'seed';

/**
 * Kopiert fehlende Einträge aus `seedDir` nach `targetDir`.
 *
 * @param {string} seedDir Quelle (fehlt sie, passiert nichts — ein
 *   Standalone-Build ohne Saat ist kein Fehler, nur eine leere Installation).
 * @param {string} targetDir Ziel (wird angelegt, falls es fehlt).
 * @returns {Promise<string[]>} kopierte Pfade, relativ zu `targetDir`.
 */
export async function seedDataDir(seedDir, targetDir) {
    if (!existsSync(seedDir)) return [];
    const copied = [];
    await copyMissing(seedDir, targetDir, '', copied);
    // Sortiert, damit Log und Test nicht von der Reihenfolge des Dateisystems abhängen.
    return copied.sort();
}

async function copyMissing(seedDir, targetDir, relative, copied) {
    const from = path.join(seedDir, relative);
    await fs.mkdir(path.join(targetDir, relative), { recursive: true });
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
        const next = path.join(relative, entry.name);
        if (entry.isDirectory()) {
            await copyMissing(seedDir, targetDir, next, copied);
            continue;
        }
        if (!entry.isFile()) continue;
        if (existsSync(path.join(targetDir, next))) continue;
        await fs.copyFile(path.join(from, entry.name), path.join(targetDir, next));
        copied.push(next.split(path.sep).join('/'));
    }
}

async function main() {
    const root = process.env.OW_APP_ROOT ?? process.cwd();
    const target = process.argv[2] ?? process.env.OW_DATA_DIR ?? path.join(root, 'data');
    const copied = await seedDataDir(path.join(root, SEED_DIR), target);
    console.log(
        copied.length === 0
            ? `[open-workspace] Saat: nichts zu tun (${target}).`
            : `[open-workspace] Saat: ${copied.length} Datei(en) nach ${target} — ${copied.join(', ')}.`,
    );
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
    main().catch(error => {
        console.error(`[open-workspace] Saat fehlgeschlagen: ${error.message}`);
        process.exit(1);
    });
}
