#!/usr/bin/env node
/**
 * Prüfstand für den Ingress-Betrieb (SPEC §5.2/§13, M12) — Unterbau von
 * e2e/ingress.spec.ts.
 *
 * Nachgestellt wird die echte Kette von Home Assistant, nicht eine
 * bequeme Abkürzung:
 *
 *   Browser → Supervisor-Simulation (Port 3100)
 *             entfernt `/api/hassio_ingress/<token>`, setzt X-Ingress-Path
 *           → Ingress-Proxy des Add-ons (Port 3101, scripts/ingress-proxy.mjs)
 *             setzt das Präfix wieder vor den Pfad
 *           → Next-Standalone-Server (Port 3102)
 *
 * Der Anwendungsteil ist derselbe wie im Image: ein Build mit dem
 * Platzhalter, `scripts/start.mjs` als Einstieg, derselbe Rewrite. Nur
 * Supervisor und Container sind simuliert — sonst prüfte der Test seine
 * eigene Abkürzung.
 *
 * `.next-ingress` wird einmal gebaut und wiederverwendet; für einen
 * frischen Build das Verzeichnis löschen.
 */

import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = '.next-ingress';
const RUN_DIR = path.join(ROOT, '.next-ingress-run');
const PLACEHOLDER = '/__ow_base__';

export const INGRESS_TOKEN = process.env.OW_E2E_INGRESS_TOKEN ?? 'e2e-token';
export const INGRESS_PATH = `/api/hassio_ingress/${INGRESS_TOKEN}`;
const PUBLIC_PORT = Number(process.env.OW_E2E_INGRESS_PORT ?? 3100);
const ADDON_PORT = Number(process.env.OW_E2E_ADDON_PORT ?? 3101);
const NEXT_PORT = Number(process.env.OW_E2E_NEXT_PORT ?? 3102);

const log = message => console.log(`[ingress-e2e] ${message}`);

function run(command, args, options) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'inherit', ...options });
        child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${command} endete mit ${code}`))));
        child.on('error', reject);
    });
}

async function buildOnce() {
    if (existsSync(path.join(ROOT, DIST, 'standalone', 'server.js'))) {
        log(`Build ${DIST} vorhanden — wird wiederverwendet.`);
        return;
    }
    log(`Baue ${DIST} mit Platzhalter-Base-Path ${PLACEHOLDER} …`);
    await run('bun', ['run', 'build'], {
        cwd: ROOT,
        env: { ...process.env, OW_DIST_DIR: DIST, OW_BASE_PATH: PLACEHOLDER, NEXT_TELEMETRY_DISABLED: '1' },
    });
}

/** Laufverzeichnis wie im Image zusammenstellen (siehe Dockerfile). */
async function assemble() {
    await fs.rm(RUN_DIR, { recursive: true, force: true });
    await fs.cp(path.join(ROOT, DIST, 'standalone'), RUN_DIR, { recursive: true });
    await fs.cp(path.join(ROOT, DIST, 'static'), path.join(RUN_DIR, DIST, 'static'), { recursive: true });
    await fs.cp(path.join(ROOT, 'public'), path.join(RUN_DIR, 'public'), { recursive: true });
    await fs.mkdir(path.join(RUN_DIR, 'scripts'), { recursive: true });
    for (const script of ['start.mjs', 'base-path.mjs', 'ingress-proxy.mjs']) {
        await fs.cp(path.join(ROOT, 'scripts', script), path.join(RUN_DIR, 'scripts', script));
    }
    // Wie im Image: der Anwendungsnutzer besitzt das Laufverzeichnis. Nur
    // als root relevant — dann gibt scripts/start.mjs die Rechte auch
    // wirklich ab, statt den Pfad zu überspringen.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
        await run('chown', ['-R', '1001:1001', RUN_DIR]);
    }
}

/**
 * Supervisor-Simulation: entfernt das Ingress-Präfix und meldet es im
 * Header — genau das Verhalten, an dem eine nicht base-path-fähige App
 * scheitert.
 */
function startSupervisorSimulation() {
    const server = http.createServer((req, res) => {
        const url = req.url ?? '/';
        if (!url.startsWith(INGRESS_PATH)) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Außerhalb des Ingress-Pfads — Home Assistant liefert hier nichts aus.\n');
            return;
        }
        // Der Supervisor reicht immer einen Pfad weiter: die Wurzel des
        // Ingress (mit oder ohne Query) wird zu '/'.
        const rest = url.slice(INGRESS_PATH.length);
        const forwarded = rest === '' ? '/' : rest.startsWith('?') ? `/${rest}` : rest;
        const proxied = http.request(
            {
                host: '127.0.0.1',
                port: ADDON_PORT,
                method: req.method,
                path: forwarded,
                headers: {
                    ...req.headers,
                    host: `127.0.0.1:${ADDON_PORT}`,
                    'x-ingress-path': INGRESS_PATH,
                    // Home Assistant reicht den angemeldeten Nutzer mit.
                    'x-remote-user-id': 'ha-e2e-user',
                    'x-remote-user-display-name': 'E2E-Nutzer',
                },
            },
            upstream => {
                res.writeHead(upstream.statusCode ?? 502, upstream.headers);
                upstream.pipe(res);
            },
        );
        proxied.on('error', error => {
            if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`Add-on nicht erreichbar: ${error.message}\n`);
        });
        req.pipe(proxied);
    });
    return new Promise(resolve => {
        server.listen(PUBLIC_PORT, '127.0.0.1', () => {
            log(`Supervisor-Simulation auf :${PUBLIC_PORT}${INGRESS_PATH} → Add-on :${ADDON_PORT}`);
            resolve(server);
        });
    });
}

async function waitForReady(timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${PUBLIC_PORT}${INGRESS_PATH}/`);
            if (response.ok) return;
        } catch {
            // Der Prozess fährt noch hoch.
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Der Ingress-Prüfstand wurde nicht rechtzeitig erreichbar.');
}

async function main() {
    await buildOnce();
    await assemble();

    const child = spawn(process.execPath, [path.join(RUN_DIR, 'scripts', 'start.mjs')], {
        cwd: RUN_DIR,
        stdio: 'inherit',
        env: {
            ...process.env,
            NODE_ENV: 'production',
            OW_INGRESS: '1',
            OW_BASE_PATH: INGRESS_PATH,
            OW_DIST_DIR: DIST,
            OW_RUNTIME: 'ha-addon',
            OW_AUTH_MODE: 'ha-ingress',
            PORT: String(ADDON_PORT),
            OW_INTERNAL_PORT: String(NEXT_PORT),
        },
    });

    const supervisor = await startSupervisorSimulation();
    const shutdown = () => {
        child.kill('SIGTERM');
        supervisor.close();
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    child.on('exit', code => {
        supervisor.close();
        process.exit(code ?? 0);
    });

    await waitForReady();
    log('Bereit.');
}

main().catch(error => {
    console.error(`[ingress-e2e] ${error.message}`);
    process.exit(1);
});
