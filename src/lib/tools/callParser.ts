/**
 * Streaming parser for the agent tool-call convention:
 *   [[TOOL:tool_id:{"arg":"value"}]]
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

const CALL_PATTERN = /\[\[TOOL:([\w.-]+):(.*?)\]\]/s;

export class ToolCallStreamFilter {
    private pending = '';
    readonly calls: ParsedToolCall[] = [];

    /** Feed a chunk; returns text safe to show to the user. */
    feed(chunk: string): string {
        let text = this.pending + chunk;
        this.pending = '';
        let visible = '';

        for (;;) {
            const match = CALL_PATTERN.exec(text);
            if (!match) break;
            visible += text.slice(0, match.index);
            this.calls.push({ toolId: match[1], rawArgs: match[2] });
            text = text.slice(match.index + match[0].length);
        }

        // Hold back a trailing partial marker ("[", "[[", "[[TOOL:...{" …)
        const partialStart = findPartialMarkerStart(text);
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
}

/**
 * Returns the index where a potential (incomplete) tool-call marker
 * starts at the end of the text, or -1 if the tail cannot become one.
 */
function findPartialMarkerStart(text: string): number {
    const idx = text.lastIndexOf('[[');
    if (idx >= 0 && !text.slice(idx).includes(']]')) {
        // "[[" that is not yet closed — could still become a tool call,
        // but only if what follows is consistent with the marker prefix.
        const tail = text.slice(idx);
        if ('[[TOOL:'.startsWith(tail.slice(0, 7)) || tail.startsWith('[[TOOL:')) {
            return idx;
        }
        return -1;
    }
    // A single trailing "[" might grow into "[["
    if (text.endsWith('[')) return text.length - 1;
    return -1;
}
