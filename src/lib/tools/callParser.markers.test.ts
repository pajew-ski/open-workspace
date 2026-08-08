import { describe, it, expect } from 'vitest';
import { CallMarkerStreamFilter } from './callParser';

/** Tests for the generalized marker parser (TOOL + AGENT keywords). */
describe('CallMarkerStreamFilter', () => {
    it('captures TOOL and AGENT markers in one stream', () => {
        const filter = new CallMarkerStreamFilter(['TOOL', 'AGENT']);
        const visible =
            filter.feed('Erst [[TOOL:weather:{"lat":1}]] dann ') +
            filter.feed('[[AGENT:research:Fasse den Bericht zusammen]] fertig.') +
            filter.flush();

        expect(visible).toBe('Erst  dann  fertig.');
        expect(filter.calls).toEqual([
            { kind: 'TOOL', id: 'weather', payload: '{"lat":1}' },
            { kind: 'AGENT', id: 'research', payload: 'Fasse den Bericht zusammen' },
        ]);
    });

    it('holds back partial AGENT markers across chunk boundaries', () => {
        const filter = new CallMarkerStreamFilter(['TOOL', 'AGENT']);
        let visible = filter.feed('Text [[AGE');
        expect(visible).toBe('Text ');
        visible += filter.feed('NT:helper:mach was]] Ende');
        visible += filter.flush();
        expect(visible).toBe('Text  Ende');
        expect(filter.calls).toEqual([{ kind: 'AGENT', id: 'helper', payload: 'mach was' }]);
    });

    it('releases non-marker brackets unchanged', () => {
        const filter = new CallMarkerStreamFilter(['TOOL', 'AGENT']);
        const visible = filter.feed('Ein [[Wiki-Link]] bleibt sichtbar') + filter.flush();
        expect(visible).toBe('Ein [[Wiki-Link]] bleibt sichtbar');
        expect(filter.calls).toEqual([]);
    });
});
