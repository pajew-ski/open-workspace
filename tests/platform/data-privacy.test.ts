// @vitest-environment node
/**
 * Die Trennung von Instanzdaten und Auslieferungsdaten als Test statt als
 * Aufmerksamkeit (Issue #32).
 *
 * Vorher war `data/` committierbar: der Graph-Snapshot samt `acl.nq`, die
 * Chatverläufe, die Kalender-Abos einer laufenden Installation lagen in
 * einem öffentlichen Repo, einen `git add -A` von der Veröffentlichung
 * entfernt. Der `git-backup`-Connector verschärfte das, weil sein
 * empfohlenes Ziel genau dort lag.
 *
 * Der Fehler ist nicht reparabel — Git vergisst nicht. Deshalb prüft diese
 * Suite die REGEL, nicht den Bestand: `git check-ignore` beantwortet die
 * Frage auch für Dateien, die es noch gar nicht gibt. Ein Test gegen den
 * Bestand wäre grün, solange niemand die Datei anlegt, die er verhindern
 * soll.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Was eine laufende Installation erzeugt. Erfundene Dateinamen mit Absicht:
 * geprüft wird die Regel, nicht der aktuelle Inhalt des Arbeitsverzeichnisses.
 */
const RUNTIME_PATHS = [
    'data/graph/workspace.nq',
    'data/graph/acl.nq',
    'data/graph/instance.json',
    'data/graph/erfundener-graph.nq',
    'data/docs/mein-privates-dokument.md',
    'data/tasks/tasks.json',
    'data/canvas/index.json',
    'data/calendar/events.json',
    'data/chat/conversations.json',
    'data/vaults/mein-vault/notiz.md',
    'data/observations/2026-08-22.ndjson',
    'data/secure/keys.json',
    'data/ai/config.json',
    'data/images/upload.png',
    'data/settings.json',
];

/** Der Auslieferungsbestand — ohne ihn startet eine frische Installation leer. */
const SEED_PATHS = [
    'seed/docs/willkommen-in-open-workspace.md',
    'seed/dashboard.json',
    'seed/canvas/index.json',
    'seed/tools/tools.json',
];

/** `git check-ignore` als Orakel: greift eine Ignore-Regel für diesen Pfad? */
function isIgnored(relative: string): boolean {
    try {
        execFileSync('git', ['check-ignore', '--quiet', '--no-index', '--', relative], { cwd: ROOT });
        return true;
    } catch (error) {
        const status = (error as { status?: number }).status;
        // 1 = keine Regel greift. Alles andere ist ein kaputter Aufruf und
        // darf nicht als „nicht ignoriert" durchgehen.
        if (status === 1) return false;
        throw error;
    }
}

describe('Instanzdaten sind von Auslieferungsdaten getrennt (Issue #32)', () => {
    it.each(RUNTIME_PATHS)('ignoriert den Laufzeitbestand %s', file => {
        expect(isIgnored(file), `${file} ist NICHT ignoriert — eine Installation könnte ihn veröffentlichen.`).toBe(true);
    });

    it.each(SEED_PATHS)('liefert die Saat %s aus', async file => {
        expect(isIgnored(file), `${file} ist ignoriert — dann liefert das Repo keine Saat mehr aus.`).toBe(false);
        await expect(fs.access(path.join(ROOT, file))).resolves.toBeUndefined();
    });

    it('hat keine Datei unter data/ mehr getrackt', () => {
        const tracked = execFileSync('git', ['ls-files', '--', 'data'], { cwd: ROOT, encoding: 'utf-8' })
            .split('\n')
            .filter(Boolean);
        expect(tracked, `Getrackter Instanzbestand: ${tracked.join(', ')}`).toEqual([]);
    });

    it('prüft überhaupt etwas — sonst wäre das Orakel nur scheinbar wirksam', () => {
        // Gegenprobe zur Gegenprobe: `check-ignore` muss auch Nein sagen können.
        expect(isIgnored('package.json')).toBe(false);
        expect(isIgnored('node_modules/irgendwas/index.js')).toBe(true);
    });
});
