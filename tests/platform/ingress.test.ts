// @vitest-environment node
/**
 * Ingress-Packaging (SPEC §5.2, M12).
 *
 * Der Supervisor liefert die App unter `/api/hassio_ingress/<token>/` aus
 * und ENTFERNT dieses Präfix, bevor er weiterreicht — Next erwartet es
 * dagegen. Diese Suite prüft die Teile, die diese Lücke schließen: die
 * Ermittlung des Pfads beim Supervisor, den Proxy, der ihn wieder
 * voransetzt, und die Add-on-Vorbereitung (persistente Daten, Optionen).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startIngressProxy } from '../../scripts/ingress-proxy.mjs';
import { applyAddonOptions, ensureData, fetchIngressEntry, isIngressMode, linkPersistentData } from '../../scripts/start.mjs';

const INGRESS = '/api/hassio_ingress/abcd1234';

function listen(server: http.Server): Promise<number> {
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            resolve((server.address() as { port: number }).port);
        });
    });
}

function close(server: http.Server): Promise<void> {
    return new Promise(resolve => server.close(() => resolve()));
}

describe('Ingress-Modus erkennen und Pfad ermitteln', () => {
    it('erkennt den Add-on-Betrieb am Supervisor-Token', () => {
        expect(isIngressMode({})).toBe(false);
        expect(isIngressMode({ SUPERVISOR_TOKEN: 'x' })).toBe(true);
        expect(isIngressMode({ OW_INGRESS: '1' })).toBe(true);
        // Ausdrückliches Abschalten schlägt das Token — für Tests und für
        // den Fall, dass das Image im Add-on-Netz ohne Ingress läuft.
        expect(isIngressMode({ OW_INGRESS: '0', SUPERVISOR_TOKEN: 'x' })).toBe(false);
    });

    it('holt den Ingress-Pfad aus der Supervisor-API', async () => {
        const calls: { url: string; auth: string | undefined }[] = [];
        const fetchImpl = (async (url: string, init?: RequestInit) => {
            calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
            return new Response(JSON.stringify({ data: { ingress_entry: `${INGRESS}/` } }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }) as unknown as typeof fetch;

        const entry = await fetchIngressEntry(
            { SUPERVISOR_TOKEN: 'geheim', OW_SUPERVISOR_HOST: 'http://supervisor' },
            fetchImpl,
        );
        expect(entry).toBe(INGRESS);
        expect(calls[0].url).toBe('http://supervisor/addons/self/info');
        expect(calls[0].auth).toBe('Bearer geheim');
    });

    it('scheitert ehrlich statt zu raten', async () => {
        await expect(fetchIngressEntry({}, fetch)).rejects.toThrow(/SUPERVISOR_TOKEN/);

        const notFound = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
        await expect(fetchIngressEntry({ SUPERVISOR_TOKEN: 'x' }, notFound)).rejects.toThrow(/404/);

        const empty = (async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
        await expect(fetchIngressEntry({ SUPERVISOR_TOKEN: 'x' }, empty)).rejects.toThrow(/ingress_entry/);
    });
});

describe('Ingress-Proxy', () => {
    let upstream: http.Server;
    let upstreamPort: number;
    let seen: { url: string; method: string }[];
    let proxy: http.Server | null = null;

    beforeEach(async () => {
        seen = [];
        upstream = http.createServer((req, res) => {
            seen.push({ url: req.url ?? '', method: req.method ?? '' });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ path: req.url }));
        });
        upstreamPort = await listen(upstream);
    });

    afterEach(async () => {
        if (proxy) await close(proxy);
        proxy = null;
        await close(upstream);
    });

    it('setzt das vom Supervisor entfernte Präfix wieder vor den Pfad', async () => {
        const port = await new Promise<number>(resolve => {
            const probe = http.createServer();
            void listen(probe).then(async free => {
                await close(probe);
                resolve(free);
            });
        });
        proxy = await startIngressProxy({ listenPort: port, targetPort: upstreamPort, basePath: INGRESS });

        const response = await fetch(`http://127.0.0.1:${port}/api/graph?x=1`, {
            headers: { 'X-Ingress-Path': INGRESS },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ path: `${INGRESS}/api/graph?x=1` });
        expect(seen[0]).toEqual({ url: `${INGRESS}/api/graph?x=1`, method: 'GET' });

        // Die Wurzel bekommt bewusst KEINEN Schrägstrich: Next liefert
        // seine Startseite unter `<basePath>` aus und leitet `<basePath>/`
        // mit 308 dorthin um — der Supervisor entfernte das Präfix dann
        // erneut, und die Umleitung liefe im Kreis.
        await fetch(`http://127.0.0.1:${port}/`);
        expect(seen[1].url).toBe(INGRESS);
        await fetch(`http://127.0.0.1:${port}/?_rsc=abc`);
        expect(seen[2].url).toBe(`${INGRESS}?_rsc=abc`);
    });

    it('meldet einen gewechselten Ingress-Token, statt falsche Links auszuliefern', async () => {
        const port = await new Promise<number>(resolve => {
            const probe = http.createServer();
            void listen(probe).then(async free => {
                await close(probe);
                resolve(free);
            });
        });
        const changes: string[] = [];
        proxy = await startIngressProxy({
            listenPort: port,
            targetPort: upstreamPort,
            basePath: INGRESS,
            onIngressPathChanged: actual => changes.push(actual),
        });

        const response = await fetch(`http://127.0.0.1:${port}/tasks`, {
            headers: { 'X-Ingress-Path': '/api/hassio_ingress/neuertoken' },
        });
        expect(response.status).toBe(503);
        expect(await response.text()).toMatch(/startet neu/);
        expect(changes).toEqual(['/api/hassio_ingress/neuertoken']);
        // Die Anfrage darf den Anwendungsprozess gar nicht erst erreichen.
        expect(seen).toHaveLength(0);
    });
});

describe('Add-on-Vorbereitung', () => {
    let root: string;
    let dataDir: string;

    beforeEach(async () => {
        const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-addon-'));
        root = path.join(base, 'app');
        dataDir = path.join(base, 'data');
        await fs.mkdir(path.join(root, 'data', 'graph'), { recursive: true });
        await fs.writeFile(path.join(root, 'data', 'graph', 'manifest.json'), '{"version":2}\n');
        await fs.mkdir(dataDir, { recursive: true });
    });

    afterEach(async () => {
        await fs.rm(path.dirname(root), { recursive: true, force: true });
    });

    it('übernimmt vorhandenen Bestand nach /data und verknüpft ihn danach', async () => {
        expect(await linkPersistentData(root, dataDir)).toBe(dataDir);

        const linked = await fs.lstat(path.join(root, 'data'));
        expect(linked.isSymbolicLink()).toBe(true);
        expect(await fs.readFile(path.join(dataDir, 'graph', 'manifest.json'), 'utf-8')).toBe('{"version":2}\n');

        // Zweiter Start: nichts wird überschrieben, nichts geht verloren.
        await fs.writeFile(path.join(dataDir, 'graph', 'manifest.json'), '{"version":3}\n');
        await linkPersistentData(root, dataDir);
        expect(await fs.readFile(path.join(root, 'data', 'graph', 'manifest.json'), 'utf-8')).toBe('{"version":3}\n');
    });

    it('sät aus seed/ nach /data — additiv, ohne Bearbeitetes zu überschreiben', async () => {
        // Auslieferungsbestand des Images (Issue #32): seed/ statt data/.
        await fs.mkdir(path.join(root, 'seed', 'docs'), { recursive: true });
        await fs.writeFile(path.join(root, 'seed', 'docs', 'willkommen.md'), 'Willkommen\n');
        await fs.writeFile(path.join(root, 'seed', 'dashboard.json'), '{"layout":[]}\n');

        await linkPersistentData(root, dataDir);
        expect(await ensureData(root, dataDir)).toEqual(['dashboard.json', 'docs/willkommen.md']);
        expect(await fs.readFile(path.join(dataDir, 'docs', 'willkommen.md'), 'utf-8')).toBe('Willkommen\n');

        // Zweiter Start nach einer Bearbeitung: die Saat hält sich zurück.
        await fs.writeFile(path.join(dataDir, 'docs', 'willkommen.md'), 'Meins\n');
        expect(await ensureData(root, dataDir)).toEqual([]);
        expect(await fs.readFile(path.join(dataDir, 'docs', 'willkommen.md'), 'utf-8')).toBe('Meins\n');
    });

    it('sät ohne persistentes Verzeichnis in das Arbeitsverzeichnis (Runtime `server`)', async () => {
        await fs.mkdir(path.join(root, 'seed'), { recursive: true });
        await fs.writeFile(path.join(root, 'seed', 'dashboard.json'), '{"layout":[]}\n');

        expect(await ensureData(root, null)).toEqual(['dashboard.json']);
        expect(await fs.readFile(path.join(root, 'data', 'dashboard.json'), 'utf-8')).toBe('{"layout":[]}\n');
    });

    it('bleibt ohne seed/ still — ein Build ohne Saat ist kein Fehler', async () => {
        expect(await ensureData(root, dataDir)).toEqual([]);
    });

    it('bleibt untätig, wenn es kein persistentes Verzeichnis gibt', async () => {
        expect(await linkPersistentData(root, null)).toBeNull();
        expect((await fs.lstat(path.join(root, 'data'))).isDirectory()).toBe(true);
    });

    it('übersetzt Add-on-Optionen in Umgebungsvariablen', async () => {
        await fs.writeFile(
            path.join(dataDir, 'options.json'),
            JSON.stringify({ log_level: 'debug', vault_roots: '/share/vaults', instance_base: '', git_roots: '/share/backup' }),
        );
        const env: Record<string, string | undefined> = { OW_GIT_ROOTS: '/vorher' };
        const applied = await applyAddonOptions(dataDir, env);

        expect(applied).toEqual({ OW_LOG_LEVEL: 'debug', OW_VAULT_ROOTS: '/share/vaults' });
        expect(env.OW_VAULT_ROOTS).toBe('/share/vaults');
        // Leere Optionen setzen nichts, gesetzte Variablen gewinnen.
        expect(env.OW_INSTANCE_BASE).toBeUndefined();
        expect(env.OW_GIT_ROOTS).toBe('/vorher');
    });

    it('meldet kaputte Optionen, statt sie zu verschlucken', async () => {
        await fs.writeFile(path.join(dataDir, 'options.json'), '{kein json');
        await expect(applyAddonOptions(dataDir, {})).rejects.toThrow(/gültiges JSON/);
    });
});
