/**
 * Die kuratierte WebLLM-Liste darf nie eine zweite Wahrheit werden: Jede
 * Angabe darin ist gegen den MITGELIEFERTEN Build geprüft — Modell-Id,
 * VRAM-Bedarf und die Tool-Calling-Markierung. Ein Versionssprung von
 * `@mlc-ai/web-llm`, der ein Modell umbenennt oder die
 * Funktionsaufruf-Liste ändert, lässt diesen Test fallen, statt eine
 * falsche Behauptung in der Oberfläche stehen zu lassen (Invariante 10).
 */
import { describe, it, expect } from 'vitest';
import { functionCallingModelIds, prebuiltAppConfig } from '@mlc-ai/web-llm';
import {
    CURATED_WEBLLM_MODELS,
    DEFAULT_WEBLLM_MODEL,
    webllmAdapter,
} from '@/lib/ai/protocols/webllm';

const catalogue = new Map(prebuiltAppConfig.model_list.map(model => [model.model_id, model]));

describe('Kuratierte WebLLM-Modelle', () => {
    it('nennt nur Modelle, die dieser Build wirklich mitbringt', () => {
        const unknown = CURATED_WEBLLM_MODELS.filter(model => !catalogue.has(model.id));
        expect(unknown.map(model => model.id)).toEqual([]);
        expect(catalogue.has(DEFAULT_WEBLLM_MODEL)).toBe(true);
    });

    it('gibt VRAM-Bedarf und Sparsam-Flag des Builds exakt wieder', () => {
        for (const model of CURATED_WEBLLM_MODELS) {
            const record = catalogue.get(model.id);
            expect([model.id, model.vramMB]).toEqual([model.id, record?.vram_required_MB]);
            expect([model.id, model.lowResource ?? false])
                .toEqual([model.id, record?.low_resource_required ?? false]);
        }
    });

    it('die angezeigte Größe passt zum VRAM-Bedarf (auf 0,1 GB gerundet)', () => {
        for (const model of CURATED_WEBLLM_MODELS) {
            if (model.vramMB === undefined) continue;
            const expected = `~${(model.vramMB / 1024).toFixed(1).replace('.', ',')} GB`;
            expect([model.id, model.sizeHint]).toEqual([model.id, expected]);
        }
    });

    it('markiert genau die Modelle als Tool-Calling-fähig, die der Build freischaltet', () => {
        const marked = CURATED_WEBLLM_MODELS.filter(model => model.nativeTools).map(model => model.id).sort();
        const supported = [...functionCallingModelIds].sort();
        // Alles Markierte ist auch freigeschaltet …
        expect(marked.every(id => supported.includes(id))).toBe(true);
        // … und kein freigeschaltetes Modell fehlt unmarkiert in der Liste.
        const curated = new Set(CURATED_WEBLLM_MODELS.map(model => model.id));
        for (const id of supported) {
            if (curated.has(id)) expect(marked).toContain(id);
        }
        // Die Empfehlung enthält überhaupt Tool-Calling-Modelle.
        expect(marked.length).toBeGreaterThan(0);
    });

    it('führt keine Duplikate und hat sprechende Labels', () => {
        const ids = CURATED_WEBLLM_MODELS.map(model => model.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(CURATED_WEBLLM_MODELS.every(model => model.label.trim() !== '')).toBe(true);
        expect(CURATED_WEBLLM_MODELS.every(model => model.sizeHint.trim() !== '')).toBe(true);
    });
});

describe('Natives Tool-Calling bleibt bewusst aus (begründet, nicht vergessen)', () => {
    it('der Build schaltet `tools` nur für eine Handvoll Modelle frei', () => {
        // Grund 1 der Begründung im Adapter: die Freigabe ist die
        // Ausnahme, nicht die Regel.
        expect(functionCallingModelIds.length).toBeLessThan(prebuiltAppConfig.model_list.length / 10);
    });

    it('der Adapter meldet deshalb kein natives Tool-Calling', () => {
        expect(webllmAdapter.supportsNativeTools).toBe(false);
    });
});
