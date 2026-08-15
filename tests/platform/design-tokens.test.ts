// @vitest-environment node
/**
 * Die Design-Token-Skala ist die EINE Quelle der Farben (AGENTS.md,
 * „Design System") — als Test, nicht als Vorsatz.
 *
 * Anlass: Ein Scan im Dark Mode fand vier ernste Kontrastfehler, und drei
 * davon hatten dieselbe Ursache. `var(--color-background)`,
 * `var(--color-text)`, `var(--color-surface-hover)` und
 * `var(--color-surface-variant)` sahen aus wie Token, standen aber in
 * keiner Skala. CSS meldet das nicht: Ohne Fallback fällt die Deklaration
 * still weg, mit Fallback gilt der fest eingetragene Wert — im Fall der
 * Assistenten-Bühne ein helles #fafafa, das auch im Dark Mode blieb,
 * während der Text dem Theme folgte (Kontrast 1,04:1).
 *
 * Diese Suite prüft deshalb zwei Dinge:
 *  1. Jedes benutzte `--token` ist irgendwo definiert.
 *  2. Jedes Farb-Token, das im Light Mode steht, hat auch im Dark Mode
 *     einen Wert — oder ist ausdrücklich themenkonstant.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const GLOBALS = path.join(SRC, 'app', 'globals.css');

/**
 * Token, die bewusst in beiden Themes denselben Wert haben. Jede Zeile
 * hier ist eine Entscheidung, keine Lücke.
 */
const THEME_CONSTANT = new Set([
    // Fläche bleibt in beiden Themes dunkelgrün, also bleibt der Text weiß.
    '--color-on-primary',
    // Die Markenfarbe selbst und ihre Ableitungen als FLÄCHE.
    '--color-primary',
    '--color-primary-dark',
    '--color-primary-light',
]);

async function cssFiles(dir: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...await cssFiles(full));
        else if (entry.name.endsWith('.css')) found.push(full);
    }
    return found;
}

describe('Design-Token-Skala', () => {
    it('kennt jedes benutzte Token — kein var() ins Leere', async () => {
        const files = await cssFiles(SRC);
        const defined = new Set<string>();
        const used = new Map<string, Set<string>>();

        for (const file of files) {
            const text = await fs.readFile(file, 'utf-8');
            for (const match of text.matchAll(/^\s*(--[\w-]+)\s*:/gm)) {
                defined.add(match[1]);
            }
            for (const match of text.matchAll(/var\(\s*(--[\w-]+)/g)) {
                const at = used.get(match[1]) ?? new Set<string>();
                at.add(path.relative(ROOT, file));
                used.set(match[1], at);
            }
        }

        const missing = [...used.entries()]
            .filter(([token]) => !defined.has(token))
            .map(([token, at]) => `${token} (${[...at].sort().join(', ')})`);

        expect(missing, missing.join('\n')).toEqual([]);
    });

    it('definiert jedes Farb-Token auch für den Dark Mode', async () => {
        const globals = await fs.readFile(GLOBALS, 'utf-8');
        const darkStart = globals.indexOf('[data-theme="dark"]');
        expect(darkStart).toBeGreaterThan(0);

        const light = globals.slice(0, darkStart);
        const dark = globals.slice(darkStart);
        const colorTokens = (block: string) =>
            new Set([...block.matchAll(/^\s*(--color-[\w-]+)\s*:/gm)].map(m => m[1]));

        const lightTokens = colorTokens(light);
        const darkTokens = colorTokens(dark);

        const onlyLight = [...lightTokens]
            .filter(token => !darkTokens.has(token) && !THEME_CONSTANT.has(token))
            .sort();

        expect(onlyLight, `Ohne Dark-Mode-Wert: ${onlyLight.join(', ')}`).toEqual([]);
    });
});
