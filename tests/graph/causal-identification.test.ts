// @vitest-environment node
/**
 * Abnahme C1 — Identifikation (CAUSAL_LAYER_SPEC §16).
 *
 * Die Spec verlangt drei Dinge:
 *
 *  1. **Testsuite gegen bekannte Lehrbuch-DAGs** — Konfundierung,
 *     Mediator, Collider, M-Bias, Frontdoor, Instrumentvariable. Die
 *     erwarteten Antworten stehen in jedem Lehrbuch; wenn dieses Modul
 *     sie nicht gibt, ist es falsch.
 *  2. **„Nicht identifizierbar" kommt korrekt UND begründet zurück**
 *     (welche Variable fehlt).
 *  3. **Läuft im Browser** — deshalb ein Test, der erzwingt, dass der
 *     Tier-1-Kern nichts importiert, was nur auf dem Server existiert.
 *
 * Die DAGs stehen hier mit sprechenden Kurznamen. Der Produktivpfad
 * (Modell aus dem Store → DAG) ist separat abgenommen, damit ein Fehler
 * in der Algorithmik nicht als Mapping-Fehler durchgeht.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    ancestors,
    createDag,
    descendants,
    findCycle,
    isAcyclic,
    topologicalOrder,
} from '@/lib/graph/causal/dag';
import { dSeparated, findPaths, impliedIndependencies } from '@/lib/graph/causal/dsep';
import {
    canonicalAdjustmentSet,
    checkAdjustment,
    identifyEffect,
    isFrontdoorSet,
} from '@/lib/graph/causal/identify';

/** `a -> b` je Zeile, wie man einen DAG von Hand hinschreibt. */
function dagOf(...edges: string[]) {
    return createDag({
        edges: edges.map(edge => {
            const [from, to] = edge.split('->').map(part => part.trim());
            return { from, to };
        }),
    });
}

// --- Lehrbuch-DAGs --------------------------------------------------------

/** Konfundierung: Z wirkt auf beides. Das Standardbild jeder Vorlesung. */
const CONFOUNDED = dagOf('Z -> X', 'Z -> Y', 'X -> Y');

/** Kette: der Effekt läuft vollständig über den Mediator. */
const CHAIN = dagOf('X -> M', 'M -> Y');

/** M-Bias: Z ist ein Collider — Adjustieren SCHADET hier. */
const M_BIAS = dagOf('U1 -> Z', 'U1 -> X', 'U2 -> Z', 'U2 -> Y', 'X -> Y');

/** Frontdoor (Raucher/Teer/Krebs): U ist unbeobachtet, der Weg über M nicht. */
const FRONTDOOR = dagOf('U -> X', 'U -> Y', 'X -> M', 'M -> Y');

/** Instrument: Z wirkt auf X und auf Y nur über X. */
const INSTRUMENT = dagOf('Z -> X', 'U -> X', 'U -> Y', 'X -> Y');

/** Der hoffnungslose Fall: ein unbeobachteter Störfaktor, sonst nichts. */
const HOPELESS = dagOf('U -> X', 'U -> Y', 'X -> Y');

describe('DAG-Grundlagen (§7 Tier 1)', () => {
    it('erkennt Azyklizität und liefert eine topologische Ordnung', () => {
        expect(isAcyclic(CONFOUNDED)).toBe(true);
        const order = topologicalOrder(CONFOUNDED);
        expect(order).not.toBeNull();
        expect((order ?? []).indexOf('Z')).toBeLessThan((order ?? []).indexOf('X'));
        expect((order ?? []).indexOf('X')).toBeLessThan((order ?? []).indexOf('Y'));
    });

    it('nennt bei einem Zyklus den Weg, nicht nur die Tatsache', () => {
        const cyclic = dagOf('A -> B', 'B -> C', 'C -> A');
        const cycle = findCycle(cyclic);
        expect(cycle).not.toBeNull();
        expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1]);
        expect(new Set(cycle)).toEqual(new Set(['A', 'B', 'C']));
        expect(topologicalOrder(cyclic)).toBeNull();
    });

    it('erkennt die Schlinge als Zyklus, statt sie stillschweigend zu schlucken', () => {
        expect(findCycle(dagOf('A -> A'))).toEqual(['A', 'A']);
    });

    it('rechnet Vorfahren und Nachfahren', () => {
        expect([...ancestors(CONFOUNDED, ['Y'], false)].sort()).toEqual(['X', 'Z']);
        expect([...descendants(CONFOUNDED, ['Z'], false)].sort()).toEqual(['X', 'Y']);
    });
});

describe('D-Separation (§7 Tier 1)', () => {
    it('blockiert die Kette, sobald der Mediator gegeben ist', () => {
        expect(dSeparated(CHAIN, ['X'], ['Y'])).toBe(false);
        expect(dSeparated(CHAIN, ['X'], ['Y'], ['M'])).toBe(true);
    });

    it('blockiert die Gabel, sobald die gemeinsame Ursache gegeben ist', () => {
        const fork = dagOf('Z -> X', 'Z -> Y');
        expect(dSeparated(fork, ['X'], ['Y'])).toBe(false);
        expect(dSeparated(fork, ['X'], ['Y'], ['Z'])).toBe(true);
    });

    it('öffnet den Collider erst durch Konditionieren — auch über einen Nachfahren', () => {
        const collider = dagOf('X -> C', 'Y -> C', 'C -> D');
        expect(dSeparated(collider, ['X'], ['Y'])).toBe(true);
        expect(dSeparated(collider, ['X'], ['Y'], ['C'])).toBe(false);
        expect(dSeparated(collider, ['X'], ['Y'], ['D'])).toBe(false);
    });

    it('zählt Pfade auf und sagt, welcher offen ist', () => {
        const result = findPaths(CONFOUNDED, 'X', 'Y');
        expect(result.truncated).toBe(false);
        const kinds = result.paths.map(p => p.kind).sort();
        expect(kinds).toEqual(['backdoor', 'causal']);
        const backdoor = result.paths.find(p => p.kind === 'backdoor');
        expect(backdoor?.nodes).toEqual(['X', 'Z', 'Y']);
        expect(backdoor?.open).toBe(true);

        const blocked = findPaths(CONFOUNDED, 'X', 'Y', { given: ['Z'] });
        expect(blocked.paths.find(p => p.kind === 'backdoor')?.open).toBe(false);
        expect(blocked.paths.find(p => p.kind === 'backdoor')?.blockedBy).toEqual(['Z']);
    });

    it('nennt die implizierten Unabhängigkeiten — die testbaren Aussagen des Modells', () => {
        const implied = impliedIndependencies(CHAIN);
        expect(implied).toEqual([{ a: 'X', b: 'Y', given: ['M'] }]);
    });
});

describe('Adjustment-Kriterium (§7 Tier 1)', () => {
    it('nimmt die gemeinsame Ursache an und lehnt den Mediator ab', () => {
        expect(checkAdjustment(CONFOUNDED, 'X', 'Y', ['Z']).valid).toBe(true);
        expect(checkAdjustment(CONFOUNDED, 'X', 'Y', []).valid).toBe(false);
        const overAdjusted = checkAdjustment(CHAIN, 'X', 'Y', ['M']);
        expect(overAdjusted.valid).toBe(false);
        expect(overAdjusted.violation).toBe('forbidden-node');
        expect(overAdjusted.offending).toBe('M');
    });

    it('lehnt einen Nachfahren der Wirkung ab (Kollider-Falle)', () => {
        const withCollider = dagOf('X -> Y', 'X -> C', 'Y -> C');
        expect(checkAdjustment(withCollider, 'X', 'Y', ['C']).violation).toBe('forbidden-node');
    });

    it('kennt die kanonische Menge', () => {
        expect(canonicalAdjustmentSet(CONFOUNDED, 'X', 'Y')).toEqual(['Z']);
        expect(canonicalAdjustmentSet(CHAIN, 'X', 'Y')).toEqual([]);
    });
});

describe('Abnahme: Identifikation gegen Lehrbuch-DAGs (§16 C1)', () => {
    it('Konfundierung: identifizierbar durch Adjustierung über die gemeinsame Ursache', () => {
        const result = identifyEffect(CONFOUNDED, 'X', 'Y');
        expect(result.identifiable).toBe(true);
        expect(result.strategy).toBe('backdoor');
        expect(result.adjustmentSets).toEqual([['Z']]);
        expect(result.reason).toContain('Adjustierung über Z');
    });

    it('Kette: identifizierbar ohne Adjustierung — und der Mediator gehört NICHT dazu', () => {
        const result = identifyEffect(CHAIN, 'X', 'Y');
        expect(result.identifiable).toBe(true);
        expect(result.adjustmentSets).toEqual([[]]);
        expect(result.adjustmentSets.flat()).not.toContain('M');
        expect(result.reason).toContain('ohne Adjustierung');
    });

    it('M-Bias: die leere Menge ist richtig, der Collider wäre der Fehler', () => {
        const result = identifyEffect(M_BIAS, 'X', 'Y', { observable: ['X', 'Y', 'Z'] });
        expect(result.identifiable).toBe(true);
        expect(result.adjustmentSets).toEqual([[]]);
        expect(checkAdjustment(M_BIAS, 'X', 'Y', ['Z']).valid).toBe(false);
    });

    it('Frontdoor: unbeobachtete Störgröße, aber ein vollständig beobachteter Wirkweg', () => {
        const result = identifyEffect(FRONTDOOR, 'X', 'Y', { observable: ['X', 'M', 'Y'] });
        expect(result.identifiable).toBe(true);
        expect(result.strategy).toBe('frontdoor');
        expect(result.frontdoorSets).toEqual([['M']]);
        expect(result.missingVariables).toEqual(['U']);
        expect(isFrontdoorSet(FRONTDOOR, 'X', 'Y', ['M'])).toBe(true);
    });

    it('Frontdoor kippt, sobald die Störgröße auch auf den Mediator wirkt', () => {
        const broken = dagOf('U -> X', 'U -> Y', 'U -> M', 'X -> M', 'M -> Y');
        expect(isFrontdoorSet(broken, 'X', 'Y', ['M'])).toBe(false);
        const result = identifyEffect(broken, 'X', 'Y', { observable: ['X', 'M', 'Y'] });
        expect(result.identifiable).toBe(false);
    });

    it('Instrument: Z wirkt auf Y nur über X', () => {
        const result = identifyEffect(INSTRUMENT, 'X', 'Y', { observable: ['Z', 'X', 'Y'] });
        expect(result.identifiable).toBe(true);
        expect(result.strategy).toBe('iv');
        expect(result.instruments.map(instrument => instrument.node)).toEqual(['Z']);
        expect(result.instruments[0].given).toEqual([]);
    });

    it('Instrument wird abgelehnt, wenn es auch direkt auf die Wirkung zeigt', () => {
        const leaky = dagOf('Z -> X', 'Z -> Y', 'U -> X', 'U -> Y', 'X -> Y');
        const result = identifyEffect(leaky, 'X', 'Y', { observable: ['Z', 'X', 'Y'] });
        expect(result.instruments).toEqual([]);
        expect(result.identifiable).toBe(false);
    });

    it('kein Wirkweg: das Modell behauptet keinen Effekt, und das ist die Antwort', () => {
        const result = identifyEffect(dagOf('X -> A', 'B -> Y'), 'X', 'Y');
        expect(result.zeroEffect).toBe(true);
        expect(result.identifiable).toBe(true);
        expect(result.strategy).toBe('none');
        expect(result.reason).toContain('keinen Wirkweg');
    });

    it('Zyklus: keine Aussage, aber ein benannter Zyklus', () => {
        const result = identifyEffect(dagOf('X -> Y', 'Y -> Z', 'Z -> X'), 'X', 'Y');
        expect(result.acyclic).toBe(false);
        expect(result.identifiable).toBe(false);
        expect(result.reason).toContain('nicht azyklisch');
        expect(result.cycle?.length).toBeGreaterThan(2);
    });
});

describe('Abnahme: „nicht identifizierbar" kommt begründet zurück (§16 C1)', () => {
    it('nennt die fehlende Variable beim Namen', () => {
        const result = identifyEffect(HOPELESS, 'X', 'Y', { observable: ['X', 'Y'] });
        expect(result.identifiable).toBe(false);
        expect(result.missingVariables).toEqual(['U']);
        expect(result.reason).toContain('Nicht identifizierbar');
        expect(result.reason).toContain('U');
        expect(result.adjustmentSets).toEqual([]);
    });

    it('benutzt die Beschriftung des Modells, nicht die IRI', () => {
        const result = identifyEffect(HOPELESS, 'X', 'Y', {
            observable: ['X', 'Y'],
            label: node => ({ U: 'Außentemperatur', X: 'Fenster offen', Y: 'Heizenergie' })[node] ?? node,
        });
        expect(result.reason).toContain('Außentemperatur');
    });

    it('trennt „nicht erfasst" von „strukturell unmöglich"', () => {
        // Dieselbe Struktur, aber U ist erfasst: dann ist es identifizierbar.
        const observed = identifyEffect(HOPELESS, 'X', 'Y');
        expect(observed.identifiable).toBe(true);
        expect(observed.adjustmentSets).toEqual([['U']]);
        expect(observed.missingVariables).toEqual([]);
    });

    it('weist einen offenen Weg aus, damit die Begründung nachvollziehbar ist', () => {
        const result = identifyEffect(HOPELESS, 'X', 'Y', { observable: ['X', 'Y'] });
        expect(result.openBackdoorPaths.map(p => p.nodes.join('-'))).toEqual(['X-U-Y']);
    });
});

describe('Abnahme: läuft im Browser (§16 C1)', () => {
    const TIER1 = ['dag.ts', 'dsep.ts', 'identify.ts'];

    it('importiert nichts, was es nur auf dem Server gibt', () => {
        for (const file of TIER1) {
            const source = readFileSync(path.join(process.cwd(), 'src/lib/graph/causal', file), 'utf-8');
            const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1]);
            for (const specifier of imports) {
                expect(specifier.startsWith('./') || specifier.startsWith('../')).toBe(true);
                expect(specifier).not.toContain('node:');
                expect(specifier).not.toContain('store');
            }
            expect(source).not.toContain('process.');
            expect(source).not.toContain('fetch(');
        }
    });

    it('bleibt auch bei einem breiten Modell in einem Budget, das ein Browser trägt', () => {
        // 40 Störgrößen auf beiden Seiten — mehr, als ein Mensch je
        // modelliert, und trotzdem eine Antwort ohne Hänger.
        const edges = ['X -> Y'];
        for (let i = 0; i < 40; i += 1) {
            edges.push(`C${i} -> X`, `C${i} -> Y`);
        }
        const wide = dagOf(...edges);
        const started = Date.now();
        const result = identifyEffect(wide, 'X', 'Y', { maxSetSize: 2 });
        expect(Date.now() - started).toBeLessThan(3000);
        // Eine MINIMALE Menge braucht alle 40 Störgrößen und wird bei
        // Suchtiefe 2 nicht gefunden. Identifizierbar ist der Effekt
        // trotzdem — über die kanonische Menge, und genau das sagt das
        // Ergebnis, statt die Antwort zu verweigern.
        expect(result.identifiable).toBe(true);
        expect(result.strategy).toBe('backdoor');
        expect(result.canonicalSet?.length).toBe(40);
        expect(result.adjustmentSets).toEqual([result.canonicalSet]);
        expect(result.adjustmentSetsMinimal).toBe(false);
        expect(result.reason).toContain('kanonische Menge');
        expect(result.truncated).toBe(true);
    });
});
