#!/usr/bin/env node
/**
 * Start-Einstieg des Container-Images (SPEC §5.2, M12).
 *
 * EIN Image, zwei Kontexte:
 *
 *  - Runtime `server` (docker compose): die App läuft an der Wurzel oder
 *    unter einem festen Präfix (`OW_BASE_PATH`), Next hört direkt auf `PORT`.
 *  - Runtime `ha-addon`: der Supervisor nennt uns über seine API den
 *    Ingress-Pfad (`/api/hassio_ingress/<token>`). Der wird in den Build
 *    eingesetzt (scripts/base-path.mjs), Next hört nur auf localhost, und
 *    davor steht der Ingress-Proxy (scripts/ingress-proxy.mjs), der das vom
 *    Supervisor entfernte Präfix wieder vor den Pfad setzt.
 *
 * Unterschied ist ausschließlich das Packaging — kein zweites Dockerfile,
 * kein zweiter Anwendungspfad.
 */

import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { applyBasePath, normalizeBasePath } from './base-path.mjs';
import { startIngressProxy } from './ingress-proxy.mjs';
import { SEED_DIR, seedDataDir } from './seed-data.mjs';

const log = message => console.log(`[open-workspace] ${message}`);

/**
 * Läuft dieses Image als Home-Assistant-Add-on?
 * @param {Record<string, string | undefined>} [env]
 */
export function isIngressMode(env = process.env) {
    if (env.OW_INGRESS === '1') return true;
    if (env.OW_INGRESS === '0') return false;
    return Boolean(env.SUPERVISOR_TOKEN);
}

/**
 * Ingress-Pfad beim Supervisor erfragen. Ohne ihn ist das Add-on nicht
 * bedienbar — deshalb ein ehrlicher Fehler statt eines Rate-Werts.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string>}
 */
export async function fetchIngressEntry(env = process.env, fetchImpl = fetch) {
    if (env.OW_BASE_PATH) return normalizeBasePath(env.OW_BASE_PATH);
    const token = env.SUPERVISOR_TOKEN;
    if (!token) {
        throw new Error('Ingress-Modus ohne SUPERVISOR_TOKEN: der Ingress-Pfad ist nicht ermittelbar.');
    }
    const host = env.OW_SUPERVISOR_HOST ?? 'http://supervisor';
    const response = await fetchImpl(`${host}/addons/self/info`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
        throw new Error(`Supervisor-API antwortete mit ${response.status} — Ingress-Pfad unbekannt.`);
    }
    const payload = await response.json();
    const entry = payload?.data?.ingress_entry ?? payload?.ingress_entry;
    if (typeof entry !== 'string' || !entry.startsWith('/')) {
        throw new Error('Supervisor-API lieferte keinen `ingress_entry` — Ingress-Pfad unbekannt.');
    }
    return normalizeBasePath(entry);
}

/** Build-Verzeichnisse, in denen der Platzhalter steckt. */
function rewriteTargets(root) {
    const targets = [];
    if (existsSync(path.join(root, 'server.js'))) targets.push('server.js');
    const distDir = process.env.OW_DIST_DIR ?? '.next';
    if (existsSync(path.join(root, distDir))) targets.push(distDir);
    if (targets.length === 0) {
        throw new Error(`Kein Build gefunden (${root}): weder server.js noch ${distDir}.`);
    }
    return targets;
}

/**
 * Add-on-Datenablage: Der Supervisor gibt jedem Add-on ein persistentes
 * `/data`. Die App liest ihren Bestand aus `<root>/data`, das deshalb ein
 * Symlink dorthin wird. Ohne diesen Schritt wäre jedes Add-on-Update ein
 * Datenverlust.
 *
 * Der Saat-Bestand kommt seit Issue #32 NICHT mehr aus `<root>/data` —
 * dieses Verzeichnis ist reiner Instanzbestand und liegt weder im Repo
 * noch im Image. Gesät wird aus `<root>/seed`, und zwar in `ensureData()`
 * für beide Runtimes gleich.
 *
 * @param {string} root
 * @param {string | null | undefined} dataDir
 * @returns {Promise<string | null>}
 */
export async function linkPersistentData(root, dataDir) {
    if (!dataDir || !existsSync(dataDir)) return null;
    const appData = path.join(root, 'data');
    const stats = await fs.lstat(appData).catch(() => null);
    if (stats?.isSymbolicLink()) return dataDir;

    if (stats?.isDirectory()) {
        // Was ein früherer Lauf im Image-Verzeichnis angelegt hat, gehört
        // dem Betreiber — es wandert mit, überschreibt aber nichts.
        await fs.cp(appData, dataDir, { recursive: true, force: false, errorOnExist: false });
    }
    if (stats) await fs.rm(appData, { recursive: true, force: true });
    await fs.symlink(dataDir, appData, 'dir');
    return dataDir;
}

/**
 * Saat ausbringen: fehlende Auslieferungsdateien aus `<root>/seed` nach
 * `<dataDir>` bzw. `<root>/data`. Additiv — bearbeiteter Bestand bleibt
 * unangetastet (scripts/seed-data.mjs).
 *
 * @param {string} root
 * @param {string | null | undefined} dataDir
 * @returns {Promise<string[]>}
 */
export async function ensureData(root, dataDir) {
    const target = dataDir ?? path.join(root, 'data');
    return seedDataDir(path.join(root, SEED_DIR), target);
}

/**
 * Add-on-Optionen (`/data/options.json`, Schema in deploy/ha-addon/config.yaml)
 * in Umgebungsvariablen übersetzen — die App kennt nur Letztere. Bereits
 * gesetzte Variablen gewinnen, damit `docker run -e …` nichts überschreibt.
 *
 * @param {string | null | undefined} dataDir
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<Record<string, string>>}
 */
export async function applyAddonOptions(dataDir, env = process.env) {
    if (!dataDir) return {};
    const file = path.join(dataDir, 'options.json');
    if (!existsSync(file)) return {};
    let options;
    try {
        options = JSON.parse(await fs.readFile(file, 'utf-8'));
    } catch (error) {
        throw new Error(`Add-on-Optionen (${file}) sind kein gültiges JSON: ${error.message}`);
    }
    const mapping = {
        instance_base: 'OW_INSTANCE_BASE',
        vault_roots: 'OW_VAULT_ROOTS',
        git_roots: 'OW_GIT_ROOTS',
        log_level: 'OW_LOG_LEVEL',
    };
    const applied = {};
    for (const [option, variable] of Object.entries(mapping)) {
        const value = options?.[option];
        if (typeof value !== 'string' || value === '') continue;
        if (env[variable]) continue;
        env[variable] = value;
        applied[variable] = value;
    }
    return applied;
}

/**
 * Als root gestartet (so startet der Supervisor Add-ons) geben wir die
 * Rechte wieder ab: Datenverzeichnis übereignen, dann selbst auf den
 * Anwendungs-Nutzer wechseln. Der Anwendungsprozess läuft damit in beiden
 * Kontexten unprivilegiert.
 *
 * @param {{recursive?: (string|null|undefined)[], shallow?: (string|null|undefined)[]}} [paths]
 * @param {Record<string, string | undefined>} [env]
 */
export async function dropPrivileges({ recursive = [], shallow = [] } = {}, env = process.env) {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) return null;
    const uid = Number(env.OW_UID ?? 1001);
    const gid = Number(env.OW_GID ?? 1001);
    if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid === 0) return null;
    for (const target of recursive) {
        if (target && existsSync(target)) await chownRecursive(target, uid, gid);
    }
    for (const target of shallow) {
        // Nur der Ordner selbst — der Build gehört dem Anwendungs-Nutzer
        // bereits aus dem Image, und ein rekursiver Lauf über node_modules
        // wäre reine Startzeit ohne Wirkung.
        if (target && existsSync(target)) await fs.lchown(target, uid, gid).catch(() => undefined);
    }
    process.setgid(gid);
    process.setuid(uid);
    return { uid, gid };
}

async function chownRecursive(target, uid, gid) {
    const stats = await fs.lstat(target).catch(() => null);
    if (!stats) return;
    await fs.lchown(target, uid, gid).catch(() => undefined);
    if (!stats.isDirectory()) return;
    for (const entry of await fs.readdir(target)) {
        await chownRecursive(path.join(target, entry), uid, gid);
    }
}

async function main() {
    const root = process.env.OW_APP_ROOT ?? process.cwd();
    const ingress = isIngressMode();
    const basePath = ingress
        ? await fetchIngressEntry()
        : normalizeBasePath(process.env.OW_BASE_PATH);

    // Packaging-Schritte, solange wir sie noch dürfen (Add-on startet als root).
    const dataDir = await linkPersistentData(root, process.env.OW_DATA_DIR ?? (ingress ? '/data' : null));
    const seeded = await ensureData(root, dataDir);
    if (seeded.length > 0) log(`Saat ausgebracht: ${seeded.length} Datei(en) (${seeded.slice(0, 3).join(', ')}${seeded.length > 3 ? ', …' : ''}).`);
    const options = await applyAddonOptions(dataDir);
    if (Object.keys(options).length > 0) log(`Add-on-Optionen übernommen: ${Object.keys(options).join(', ')}.`);
    const dropped = await dropPrivileges({
        recursive: [dataDir ?? path.join(root, 'data')],
        shallow: [root],
    });
    if (dropped) log(`Rechte abgegeben: läuft als uid ${dropped.uid}:${dropped.gid}.`);

    const result = await applyBasePath({ root, basePath, targets: rewriteTargets(root) });
    log(
        result.changedFiles === 0
            ? `Base-Path unverändert (${result.to || '/'}).`
            : `Base-Path gesetzt: "${result.from}" → "${result.to || '/'}" `
              + `(${result.replacements} Stellen in ${result.changedFiles} Dateien).`,
    );

    const publicPort = Number(process.env.PORT ?? (ingress ? 8099 : 3000));
    const internalPort = ingress ? Number(process.env.OW_INTERNAL_PORT ?? 3001) : publicPort;

    const child = spawn(process.execPath, [path.join(root, 'server.js')], {
        cwd: root,
        stdio: 'inherit',
        env: {
            ...process.env,
            PORT: String(internalPort),
            // Im Ingress-Modus ist Next ausschließlich über den Proxy erreichbar.
            HOSTNAME: ingress ? '127.0.0.1' : (process.env.HOSTNAME ?? '0.0.0.0'),
            OW_BASE_PATH: basePath,
            OW_RUNTIME: process.env.OW_RUNTIME ?? (ingress ? 'ha-addon' : 'server'),
        },
    });

    let shuttingDown = false;
    const shutdown = code => {
        if (shuttingDown) return;
        shuttingDown = true;
        child.kill('SIGTERM');
        setTimeout(() => process.exit(code), 500).unref();
    };
    process.on('SIGTERM', () => shutdown(0));
    process.on('SIGINT', () => shutdown(0));
    child.on('exit', code => process.exit(code ?? 0));

    if (ingress) {
        await startIngressProxy({
            listenPort: publicPort,
            targetPort: internalPort,
            basePath,
            log,
            // Ein rotierter Ingress-Token macht jede eingebackene URL falsch.
            // Neustart ist die einzige ehrliche Antwort — der Supervisor
            // startet das Add-on wieder, der Build bekommt den neuen Pfad.
            onIngressPathChanged: () => shutdown(1),
        });
    } else {
        log(`Workspace läuft auf :${publicPort}${basePath || ''}`);
    }
}

// Nur ausführen, wenn direkt gestartet (die Funktionen oben sind getestet).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
    main().catch(error => {
        console.error(`[open-workspace] Start fehlgeschlagen: ${error.message}`);
        process.exit(1);
    });
}
