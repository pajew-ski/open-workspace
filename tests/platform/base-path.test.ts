/**
 * Base-Path-Fähigkeit (SPEC §5.2, M12) — Abnahme der Ingress-Voraussetzung.
 *
 * Der Ingress-Pfad steht erst zur Installationszeit fest. Diese Suite
 * prüft die drei Bausteine, die das tragen: die Pfad-Regel selbst, den
 * Fetch-Filter (die EINE Stelle, an der Feature-Code den Präfix bekommt)
 * und das Einsetzen des Platzhalters in einen fertigen Build.
 *
 * Der Ingress-Weg von außen — Supervisor entfernt Präfix, Proxy setzt es
 * wieder — läuft als E2E-Test (e2e/ingress.spec.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    installBasePathFetch,
    normalizeBasePath,
    stripBasePath,
    withBasePath,
} from '../../src/lib/platform/base-path';
import {
    applyBasePath,
    currentBasePath,
    BASE_PATH_MARKER,
    // Der Platzhalter ist NUR hier definiert — im App-Code darf er nicht als
    // Zeichenkette stehen (siehe Test weiter unten).
    BASE_PATH_PLACEHOLDER,
    normalizeBasePath as normalizeInScript,
} from '../../scripts/base-path.mjs';

const INGRESS = '/api/hassio_ingress/abcd1234';

function setBasePath(value: string | undefined): void {
    if (value === undefined) delete process.env.NEXT_PUBLIC_OW_BASE_PATH;
    else process.env.NEXT_PUBLIC_OW_BASE_PATH = value;
}

describe('Base-Path-Regel', () => {
    afterEach(() => setBasePath(undefined));

    it('normalisiert Eingaben und lehnt Unfug still ab', () => {
        expect(normalizeBasePath(undefined)).toBe('');
        expect(normalizeBasePath('')).toBe('');
        expect(normalizeBasePath('/')).toBe('');
        expect(normalizeBasePath(INGRESS)).toBe(INGRESS);
        expect(normalizeBasePath(`${INGRESS}/`)).toBe(INGRESS);
        expect(normalizeBasePath('api/hassio_ingress/x')).toBe('/api/hassio_ingress/x');
    });

    it('behält den Platzhalter beim Bauen — sonst wäre er nicht mehr ersetzbar', () => {
        // Vorgerenderte Seiten entstehen mit dem Platzhalter als Base-Path.
        // Würde er hier verworfen, stünde in der fertigen Seite ein Pfad
        // OHNE Präfix — der Start-Schritt fände nichts mehr zum Ersetzen,
        // und unter Ingress zeigten Manifest- und Asset-Links ins Leere.
        setBasePath(BASE_PATH_PLACEHOLDER);
        expect(withBasePath('/manifest.webmanifest')).toBe(`${BASE_PATH_PLACEHOLDER}/manifest.webmanifest`);
    });

    it('vergleicht im App-Code nirgends gegen den Platzhalter', async () => {
        // Ein Vergleich gegen den Platzhalter wäre nach dem Start-Rewrite
        // ein Vergleich gegen den ECHTEN Base-Path — und würde ihn
        // verwerfen. Der Platzhalter gehört ausschließlich ins Start-Skript.
        const offenders: string[] = [];
        const scan = async (dir: string): Promise<void> => {
            for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await scan(full);
                    continue;
                }
                if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
                const source = await fs.readFile(full, 'utf-8');
                if (/[=!]==\s*['"`]?\/__ow_base__/.test(source)) offenders.push(full);
            }
        };
        await scan(path.resolve(__dirname, '..', '..', 'src'));
        expect(offenders).toEqual([]);
    });

    it('gilt in TypeScript und im Start-Skript identisch', () => {
        // Ohne den Platzhalter: das Start-Skript liest Konfiguration (dort
        // heißt „Platzhalter" = kein Pfad), die App liest ihren eingebackenen
        // Wert (dort ist der Platzhalter ein gültiger Zwischenzustand).
        for (const value of ['', '/', INGRESS, `${INGRESS}/`, 'workspace', '/a/b/']) {
            expect(normalizeInScript(value)).toBe(normalizeBasePath(value));
        }
    });

    it('präfixt App-Pfade genau einmal und lässt Fremdes in Ruhe', () => {
        setBasePath(INGRESS);
        expect(withBasePath('/api/graph')).toBe(`${INGRESS}/api/graph`);
        expect(withBasePath(`${INGRESS}/api/graph`)).toBe(`${INGRESS}/api/graph`);
        expect(withBasePath('/')).toBe(`${INGRESS}/`);
        expect(withBasePath('https://example.org/api')).toBe('https://example.org/api');
        expect(withBasePath('relativ/pfad')).toBe('relativ/pfad');
        expect(stripBasePath(`${INGRESS}/tasks`)).toBe('/tasks');
        expect(stripBasePath('/tasks')).toBe('/tasks');
    });

    it('ist ohne Base-Path die Identität', () => {
        setBasePath('');
        expect(withBasePath('/api/graph')).toBe('/api/graph');
        expect(stripBasePath('/api/graph')).toBe('/api/graph');
    });
});

describe('Fetch-Filter', () => {
    let original: typeof fetch;

    beforeEach(() => {
        original = vi.fn(async () => new Response('ok')) as unknown as typeof fetch;
        window.fetch = original;
    });

    afterEach(() => {
        setBasePath(undefined);
        // Der Filter ersetzt window.fetch — für die nächste Suite zurücksetzen.
        window.fetch = original;
    });

    it('setzt den Präfix vor absolute App-Pfade, egal in welcher Aufrufform', async () => {
        setBasePath(INGRESS);
        installBasePathFetch();

        await window.fetch('/api/graph');
        await window.fetch(new URL('/api/finder', window.location.origin));
        await window.fetch(new Request(`${window.location.origin}/api/tasks`));

        const calls = (original as unknown as { mock: { calls: unknown[][] } }).mock.calls;
        expect(String(calls[0][0])).toBe(`${INGRESS}/api/graph`);
        expect(new URL(String(calls[1][0])).pathname).toBe(`${INGRESS}/api/finder`);
        expect(new URL((calls[2][0] as Request).url).pathname).toBe(`${INGRESS}/api/tasks`);
    });

    it('lässt fremde Origins und bereits präfixte Pfade unverändert', async () => {
        setBasePath(INGRESS);
        installBasePathFetch();

        await window.fetch('https://api.example.org/v1');
        await window.fetch(`${INGRESS}/api/graph`);

        const calls = (original as unknown as { mock: { calls: unknown[][] } }).mock.calls;
        expect(String(calls[0][0])).toBe('https://api.example.org/v1');
        expect(String(calls[1][0])).toBe(`${INGRESS}/api/graph`);
    });

    it('ist ohne Base-Path ein No-Op und installiert sich nicht doppelt', async () => {
        setBasePath('');
        installBasePathFetch();
        expect(window.fetch).toBe(original);

        setBasePath(INGRESS);
        installBasePathFetch();
        const patched = window.fetch;
        installBasePathFetch();
        expect(window.fetch).toBe(patched);
    });
});

describe('Platzhalter im Build ersetzen', () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-basepath-'));
        await fs.mkdir(path.join(root, '.next', 'static'), { recursive: true });
        await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
        await fs.writeFile(
            path.join(root, 'server.js'),
            `const config = { basePath: "${BASE_PATH_PLACEHOLDER}", assetPrefix: "${BASE_PATH_PLACEHOLDER}" };\n`,
        );
        await fs.writeFile(
            path.join(root, '.next', 'routes-manifest.json'),
            JSON.stringify({ basePath: BASE_PATH_PLACEHOLDER }),
        );
        await fs.writeFile(
            path.join(root, '.next', 'static', 'chunk.js'),
            `fetch("${BASE_PATH_PLACEHOLDER}/api/graph");`,
        );
        // Binärdatei mit derselben Bytefolge: darf NICHT angefasst werden.
        await fs.writeFile(
            path.join(root, '.next', 'static', 'icon.png'),
            Buffer.from(`\x89PNG${BASE_PATH_PLACEHOLDER}`, 'binary'),
        );
        // Abhängigkeiten bleiben außen vor.
        await fs.writeFile(path.join(root, 'node_modules', 'lib.js'), BASE_PATH_PLACEHOLDER);
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    it('setzt den Ingress-Pfad in Server- und Client-Artefakte ein', async () => {
        const result = await applyBasePath({ root, basePath: INGRESS, targets: ['server.js', '.next'] });

        expect(result.from).toBe(BASE_PATH_PLACEHOLDER);
        expect(result.to).toBe(INGRESS);
        expect(result.changedFiles).toBe(3);

        expect(await fs.readFile(path.join(root, 'server.js'), 'utf-8')).toContain(`"${INGRESS}"`);
        expect(await fs.readFile(path.join(root, '.next', 'routes-manifest.json'), 'utf-8')).toContain(INGRESS);
        expect(await fs.readFile(path.join(root, '.next', 'static', 'chunk.js'), 'utf-8'))
            .toBe(`fetch("${INGRESS}/api/graph");`);
        // Nicht-Text und Abhängigkeiten unverändert.
        expect(await fs.readFile(path.join(root, '.next', 'static', 'icon.png'), 'utf-8')).toContain(BASE_PATH_PLACEHOLDER);
        expect(await fs.readFile(path.join(root, 'node_modules', 'lib.js'), 'utf-8')).toBe(BASE_PATH_PLACEHOLDER);
        expect(await currentBasePath(root)).toBe(INGRESS);
        expect(await fs.readFile(path.join(root, BASE_PATH_MARKER), 'utf-8')).toBe(`${INGRESS}\n`);
    });

    it('ist idempotent und folgt einem gewechselten Ingress-Token', async () => {
        await applyBasePath({ root, basePath: INGRESS, targets: ['server.js', '.next'] });
        const again = await applyBasePath({ root, basePath: INGRESS, targets: ['server.js', '.next'] });
        expect(again.changedFiles).toBe(0);

        const rotated = '/api/hassio_ingress/zzzz9999';
        const moved = await applyBasePath({ root, basePath: rotated, targets: ['server.js', '.next'] });
        expect(moved.from).toBe(INGRESS);
        expect(await fs.readFile(path.join(root, '.next', 'static', 'chunk.js'), 'utf-8'))
            .toBe(`fetch("${rotated}/api/graph");`);
    });

    it('entfernt den Platzhalter für den Wurzelbetrieb — und sagt danach ehrlich Nein', async () => {
        await applyBasePath({ root, basePath: '', targets: ['server.js', '.next'] });
        expect(await fs.readFile(path.join(root, '.next', 'static', 'chunk.js'), 'utf-8'))
            .toBe('fetch("/api/graph");');

        // Ein leerer Wert ist im Build nicht mehr auffindbar: nachträglich
        // einen Pfad zu setzen wäre stilles Halb-Umschreiben.
        await expect(applyBasePath({ root, basePath: INGRESS, targets: ['server.js', '.next'] }))
            .rejects.toThrow(/Container neu starten/);
    });
});
