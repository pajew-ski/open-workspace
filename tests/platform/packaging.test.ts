// @vitest-environment node
/**
 * „Dasselbe Image läuft in beiden Kontexten" (SPEC §5.2/§13, M12) —
 * als Test, nicht als Vorsatz.
 *
 * Die Spec nennt ein zweites Dockerfile ausdrücklich einen Review-Blocker.
 * Diese Suite prüft deshalb die Packaging-Invarianten: EIN Dockerfile, ein
 * Einstieg, und beide Packagings (Add-on-Konfiguration und Compose)
 * verweisen auf genau dieses Image statt ein eigenes zu bauen.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(__dirname, '..', '..');
const SKIP = new Set(['node_modules', '.git', '.next', 'test-results', 'playwright-report']);

async function findDockerfiles(dir: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.next-')) continue;
        if (SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            found.push(...await findDockerfiles(full));
            continue;
        }
        if (/^Dockerfile(\..+)?$/.test(entry.name)) found.push(path.relative(ROOT, full));
    }
    return found;
}

describe('Packaging-Invarianten', () => {
    it('hat genau EIN Dockerfile im Repo', async () => {
        expect(await findDockerfiles(ROOT)).toEqual(['Dockerfile']);
    });

    it('baut mit dem Base-Path-Platzhalter und startet über scripts/start.mjs', async () => {
        const dockerfile = await fs.readFile(path.join(ROOT, 'Dockerfile'), 'utf-8');
        expect(dockerfile).toMatch(/ENV OW_BASE_PATH=\/__ow_base__/);
        expect(dockerfile).toMatch(/CMD \["node", "scripts\/start\.mjs"\]/);
        // Die Start-Skripte müssen im Runtime-Image liegen, sonst startet nichts.
        for (const script of ['start.mjs', 'base-path.mjs', 'ingress-proxy.mjs']) {
            expect(dockerfile).toContain(`/app/scripts/${script}`);
        }
    });

    it('lässt die Start-Skripte im Build-Kontext', async () => {
        // Ohne scripts/ im Kontext kopiert das Runtime-Image seinen eigenen
        // Einstieg nicht — der Build bricht ab, und zwar erst in Docker.
        const ignored = (await fs.readFile(path.join(ROOT, '.dockerignore'), 'utf-8'))
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'));
        expect(ignored).not.toContain('scripts');
        expect(ignored).not.toContain('scripts/');
    });

    it('verpackt das Add-on ohne eigenes Image, mit Ingress', async () => {
        const config = parseYaml(await fs.readFile(path.join(ROOT, 'deploy', 'ha-addon', 'config.yaml'), 'utf-8'));
        expect(config.image).toBeTruthy();
        expect(config.ingress).toBe(true);
        expect(typeof config.ingress_port).toBe('number');
        // Kein Build-Abschnitt: das Add-on zieht das eine Image.
        expect(config.build).toBeUndefined();
        const addonFiles = await fs.readdir(path.join(ROOT, 'deploy', 'ha-addon'));
        expect(addonFiles.filter(name => /^Dockerfile/.test(name) || name === 'build.yaml')).toEqual([]);
    });

    it('startet dieselbe Anwendung im Compose — aus demselben Dockerfile', async () => {
        const compose = parseYaml(await fs.readFile(path.join(ROOT, 'deploy', 'server', 'docker-compose.yml'), 'utf-8'));
        expect(compose.services.app.build.dockerfile).toBe('Dockerfile');
        expect(compose.services.app.build.context).toBe('../..');
        // Unprivilegiert und mit persistentem Datenvolumen.
        expect(compose.services.app.user).toBe('1001:1001');
        expect(compose.services.app.volumes).toContain('ow-data:/app/data');
        // TLS terminiert Caddy, den OIDC-Anmeldefluss der oauth2-proxy.
        expect(compose.services.caddy.ports).toContain('443:443');
        expect(compose.services['oauth2-proxy'].profiles).toContain('oidc');
    });
});
