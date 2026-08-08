/**
 * Streaming parser for inline call markers in model output:
 *   [[TOOL:tool_id:{"arg":"value"}]]   — execute a tool
 *   [[AGENT:agent_id:free-text prompt]] — delegate to another agent
 *
 * Works incrementally over streamed text chunks: complete calls are
 * captured and removed from the visible output, partial markers at the
 * end of a chunk are held back until the next chunk decides whether they
 * complete into a call.
 */

export interface ParsedToolCall {
    toolId: string;
    rawArgs: string;
}

export interface ParsedMarkerCall {
    /** Marker keyword, e.g. 'TOOL' or 'AGENT'. */
    kind: string;
    /** The id segment ([\w.-]+). */
    id: string;
    /** Raw payload between the second colon and the closing ]]. */
    payload: string;
}

/**
 * Generic streaming filter for [[KEYWORD:id:payload]] markers.
 * Complete markers are collected in `calls`; everything else passes
 * through as visible text.
 */
export class CallMarkerStreamFilter {
    private pending = '';
    private readonly pattern: RegExp;
    readonly calls: ParsedMarkerCall[] = [];

    constructor(private readonly keywords: string[] = ['TOOL']) {
        this.pattern = new RegExp(`\\[\\[(${keywords.join('|')}):([\\w.-]+):(.*?)\\]\\]`, 's');
    }

    /** Feed a chunk; returns text safe to show to the user. */
    feed(chunk: string): string {
        let text = this.pending + chunk;
        this.pending = '';
        let visible = '';

        for (;;) {
            const match = this.pattern.exec(text);
            if (!match) break;
            visible += text.slice(0, match.index);
            this.calls.push({ kind: match[1], id: match[2], payload: match[3] });
            text = text.slice(match.index + match[0].length);
        }

        // Hold back a trailing partial marker ("[", "[[", "[[TOOL:...{" …)
        const partialStart = this.findPartialMarkerStart(text);
        if (partialStart >= 0) {
            this.pending = text.slice(partialStart);
            visible += text.slice(0, partialStart);
        } else {
            visible += text;
        }
        return visible;
    }

    /** End of stream: whatever is held back was not a call after all. */
    flush(): string {
        const rest = this.pending;
        this.pending = '';
        return rest;
    }

    /**
     * Returns the index where a potential (incomplete) marker starts at
     * the end of the text, or -1 if the tail cannot become one.
     */
    private findPartialMarkerStart(text: string): number {
        const idx = text.lastIndexOf('[[');
        if (idx >= 0 && !text.slice(idx).includes(']]')) {
            // "[[" that is not yet closed — could still become a marker,
            // but only if what follows is consistent with one of the
            // keyword prefixes ("[[TOOL:", "[[AGENT:", …).
            const tail = text.slice(idx);
            for (const keyword of this.keywords) {
                const prefix = `[[${keyword}:`;
                if (prefix.startsWith(tail.slice(0, prefix.length)) || tail.startsWith(prefix)) {
                    return idx;
                }
            }
            return -1;
        }
        // A single trailing "[" might grow into "[["
        if (text.endsWith('[')) return text.length - 1;
        return -1;
    }
}

/**
 * Backwards-compatible TOOL-only filter (existing server loop + tests).
 */
export class ToolCallStreamFilter {
    private readonly inner = new CallMarkerStreamFilter(['TOOL']);

    get calls(): ParsedToolCall[] {
        return this.inner.calls.map(c => ({ toolId: c.id, rawArgs: c.payload }));
    }

    feed(chunk: string): string {
        return this.inner.feed(chunk);
    }

    flush(): string {
        return this.inner.flush();
    }
}
