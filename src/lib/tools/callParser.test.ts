import { describe, it, expect } from 'vitest';
import { ToolCallStreamFilter } from './callParser';

describe('ToolCallStreamFilter', () => {
    it('captures a complete call and strips it from visible text', () => {
        const f = new ToolCallStreamFilter();
        const visible = f.feed('Ich prüfe das Wetter. [[TOOL:weather:{"lat":52.5}]] Moment.');
        expect(visible).toBe('Ich prüfe das Wetter.  Moment.');
        expect(f.calls).toEqual([{ toolId: 'weather', rawArgs: '{"lat":52.5}' }]);
    });

    it('handles a call split across chunks', () => {
        const f = new ToolCallStreamFilter();
        let visible = f.feed('Einen Moment. [[TO');
        visible += f.feed('OL:weather:{"lat":52.5,"lon":13.4}');
        visible += f.feed(']] Fertig.');
        visible += f.flush();
        expect(visible).toBe('Einen Moment.  Fertig.');
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0].toolId).toBe('weather');
        expect(f.calls[0].rawArgs).toBe('{"lat":52.5,"lon":13.4}');
    });

    it('captures multiple calls in one stream', () => {
        const f = new ToolCallStreamFilter();
        f.feed('[[TOOL:a:{}]] und [[TOOL:b:{"x":1}]]');
        expect(f.calls.map(c => c.toolId)).toEqual(['a', 'b']);
    });

    it('does not swallow markdown link syntax', () => {
        const f = new ToolCallStreamFilter();
        const visible = f.feed('Siehe [Link](https://example.com) und [[Wiki-Link]].') + f.flush();
        expect(visible).toBe('Siehe [Link](https://example.com) und [[Wiki-Link]].');
        expect(f.calls).toHaveLength(0);
    });

    it('releases held-back text when the stream ends mid-marker', () => {
        const f = new ToolCallStreamFilter();
        const visible = f.feed('Anfang [[TOOL:web') + f.flush();
        expect(visible).toBe('Anfang [[TOOL:web');
        expect(f.calls).toHaveLength(0);
    });

    it('handles nested JSON braces in args', () => {
        const f = new ToolCallStreamFilter();
        f.feed('[[TOOL:api:{"body":{"q":"test"}}]]');
        expect(f.calls[0].rawArgs).toBe('{"body":{"q":"test"}}');
    });
});
