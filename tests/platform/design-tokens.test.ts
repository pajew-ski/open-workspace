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
 *     einen Wert — direkt, oder über `var(--…)`-Verweise auf Tokens, die
 *     ihrerseits im Dark Mode stehen (die Familien-Skala flippt, und die
 *     `--color-*`-Token leiten daraus ab) — oder ist ausdrücklich
 *     themenkonstant.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const GLOBALS = path.join(SRC, 'app', 'globals.css');

/**
 * Token, die bewusst in beiden Themes denselben Wert haben. Jede Zeile
 * hier ist eine Entscheidung, keine Lücke. Seit der achromatischen Skala
 * ist das Set leer: Die Primärfarbe IST die Textfarbe und flippt mit ihr,
 * es gibt keine themenkonstante Fläche mehr. Das Set bleibt stehen, damit
 * eine künftige Ausnahme hier begründet wird statt im Test zu verschwinden.
 */
const THEME_CONSTANT = new Set<string>([]);

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
        const declarations = (block: string) =>
            new Map([...block.matchAll(/^\s*(--[\w-]+)\s*:\s*([^;]+);/gm)].map(m => [m[1], m[2].trim()]));

        const lightDecls = declarations(light);
        const darkTokens = new Set(declarations(dark).keys());

        /**
         * Dark-abgedeckt ist ein Token, das im Dark-Block steht — oder
         * dessen Light-Wert ausschließlich aus `var(--…)`-Verweisen auf
         * Tokens besteht, die selbst dark-abgedeckt sind (rekursiv). Ein
         * Zyklus oder ein Literal neben dem Verweis zählt nicht.
         */
        const covered = (token: string, seen: Set<string> = new Set()): boolean => {
            if (darkTokens.has(token)) return true;
            if (seen.has(token)) return false;
            seen.add(token);
            const value = lightDecls.get(token);
            if (!value) return false;
            const refs = [...value.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map(m => m[1]);
            if (refs.length === 0) return false;
            const rest = value.replace(/var\(\s*--[\w-]+\s*\)/g, '').trim();
            if (rest !== '') return false;
            return refs.every(ref => covered(ref, seen));
        };

        const onlyLight = [...lightDecls.keys()]
            .filter(token => token.startsWith('--color-'))
            .filter(token => !covered(token) && !THEME_CONSTANT.has(token))
            .sort();

        expect(onlyLight, `Ohne Dark-Mode-Wert: ${onlyLight.join(', ')}`).toEqual([]);
    });
});
