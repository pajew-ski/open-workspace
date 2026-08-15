// @vitest-environment node
/**
 * Die Emoji-Regel als Test statt als Vorsatz.
 *
 * `.agent/rules/emojis.md` gilt `always_on`, stand aber in einer Datei,
 * die keine der drei Doku-Ebenen erwähnte — entsprechend erodierte sie:
 * ein Emoji in einer Canvas-Karte, 33 Status-Glyphen in den Specs und der
 * Analyse.
 *
 * Die Grenze zieht Unicode selbst, nicht eine gepflegte Liste:
 * `Extended_Pictographic` trennt Piktogramme von Typografie. Damit bleiben
 * die Zeichen erlaubt, die in Tabellen und CLI-Ausgaben BEDEUTUNG tragen
 * (✓ ✗ ✕ ✎ → ⇒ ★), und verboten sind die, die nur Stimmung tragen
 * (✅ ⏳ ❌ 📄). Zwei Ausnahmen sind benannt statt geraten.
 *
 * Nicht geprüft wird `data/` — was ein Nutzer in seine Notizen oder seinen
 * Chatverlauf schreibt, ist seine Sache und nicht die des Repos.
 *
 * Bewusst NICHT als Test gebaut: die du-Form (AGENTS.md,
 * „Code-Konventionen"). Im Deutschen ist „Sie" am Satzanfang nicht
 * maschinell von „sie" als Plural zu unterscheiden — „Sie sind Projektion,
 * nicht Wahrheit" ist korrektes Duzen. Ein Test darüber wäre ein
 * Fehlalarm-Generator; die Regel bleibt Sache des Lesens.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

/** Unicode-Definition eines Piktogramms — keine handgepflegte Liste. */
const PICTOGRAPH = /\p{Extended_Pictographic}/u;

/**
 * Ausnahmen mit Begründung. Beide sind technische Symbole, die Unicode
 * historisch zu den Piktogrammen zählt.
 */
const ALLOWED = new Set([
    '⚙', // Zahnrad als Einstellungs-Symbol in Symbolschriften
    '☀', // Sonne als Fachzeichen der Sonnenstands-Quelle (C5)
    // Pfeile, die Unicode historisch zu den Piktogrammen zählt, die hier
    // aber Typografie sind: „Locator↔Config-Round-Trip".
    '↔', '↕', '↩', '↪',
]);

const TEXT_FILES = /\.(ts|tsx|css|md|json|ttl|ya?ml|mjs|js)$/;

async function trackedTextFiles(): Promise<string[]> {
    const listing = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf-8' });
    return listing
        .split('\n')
        .filter(Boolean)
        .filter(file => TEXT_FILES.test(file))
        .filter(file => !file.startsWith('data/') && file !== 'bun.lock');
}

describe('Repo-Regeln', () => {
    it('enthält keine Emojis (.agent/rules/emojis.md, always_on)', async () => {
        const offenders: string[] = [];
        for (const file of await trackedTextFiles()) {
            const text = await fs.readFile(path.join(ROOT, file), 'utf-8');
            text.split('\n').forEach((line, index) => {
                for (const char of line) {
                    if (PICTOGRAPH.test(char) && !ALLOWED.has(char)) {
                        offenders.push(`${file}:${index + 1}: ${char} in „${line.trim().slice(0, 70)}"`);
                        break;
                    }
                }
            });
        }
        expect(offenders, offenders.join('\n')).toEqual([]);
    });

    it('prüft überhaupt etwas — sonst wäre die Regel nur scheinbar durchgesetzt', async () => {
        const files = await trackedTextFiles();
        expect(files.length).toBeGreaterThan(100);
        expect(files).toContain('AGENTS.md');
        expect(files.some(file => file.startsWith('src/'))).toBe(true);
        // Und die Grenze liegt da, wo sie liegen soll:
        expect(PICTOGRAPH.test('✅')).toBe(true);
        expect(PICTOGRAPH.test('✓')).toBe(false);
    });
});
