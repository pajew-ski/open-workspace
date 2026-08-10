import { Tool } from './types';
import { getConnectionWithSecrets } from '@/lib/connections/manager';
import { isPrivateHostname } from '@/lib/net/private';

interface ToolExecutionResult {
    success: boolean;
    /** Antwort des Ziel-Endpunkts — Form unbekannt, Aufrufer prüft. */
    data?: unknown;
    error?: string;
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Local/private targets are blocked by default (SSRF protection).
 * Set ALLOW_LOCAL_TOOL_URLS=1 to allow them, e.g. for a local Ollama instance.
 */
function localUrlsAllowed(): boolean {
    const flag = process.env.ALLOW_LOCAL_TOOL_URLS;
    if (!flag) return false;
    const normalized = flag.trim().toLowerCase();
    return normalized !== '' && normalized !== '0' && normalized !== 'false';
}

/**
 * Substitute {key} placeholders in a JSON body template, injection-safe.
 *
 * The template is scanned with JSON string-literal awareness:
 * - Placeholder inside a string literal ("q": "hello {name}") -> the value is
 *   inserted as properly escaped string content (quotes, newlines, backslashes
 *   cannot break out of the string).
 * - Placeholder in a bare position ("lat": {lat}) -> the value is inserted as
 *   its JSON serialization (numbers stay numbers, strings get quoted).
 */
function substituteBodyTemplate(template: string, args: Record<string, unknown>): string {
    let result = '';
    let inString = false;
    let i = 0;

    while (i < template.length) {
        const ch = template[i];

        if (inString && ch === '\\') {
            // Copy escape sequences verbatim
            result += template.slice(i, i + 2);
            i += 2;
            continue;
        }

        if (ch === '"') {
            inString = !inString;
            result += ch;
            i += 1;
            continue;
        }

        if (ch === '{') {
            const close = template.indexOf('}', i);
            if (close !== -1) {
                const key = template.slice(i + 1, close);
                if (Object.prototype.hasOwnProperty.call(args, key)) {
                    const value = args[key];
                    if (inString) {
                        // Escaped string content without the surrounding quotes
                        result += JSON.stringify(String(value)).slice(1, -1);
                    } else {
                        result += JSON.stringify(value === undefined ? null : value);
                    }
                    i = close + 1;
                    continue;
                }
            }
        }

        result += ch;
        i += 1;
    }

    return result;
}

/**
 * Execute a tool with given arguments.
 * Arguments can be injected into URL placeholders (e.g. {lat}) or Body.
 */
export async function executeTool(tool: Tool, args: Record<string, unknown> = {}): Promise<ToolExecutionResult> {
    if (tool.type !== 'api') {
        return { success: false, error: 'Only API tools are currently supported' };
    }

    try {
        let url = tool.config.url || '';
        const method = tool.config.method || 'GET';
        let body = tool.config.body;
        const headers = { ...tool.config.headers };

        // Resolve Connection logic
        if (tool.connectionId) {
            const connection = await getConnectionWithSecrets(tool.connectionId);
            if (connection) {
                // Prepend base URL if tool URL is relative path
                if (connection.baseUrl && !url.startsWith('http')) {
                    // Normalize slash
                    const base = connection.baseUrl.replace(/\/$/, '');
                    const path = url.replace(/^\//, '');
                    url = `${base}/${path}`;
                } else if (connection.baseUrl && url.startsWith('/')) {
                    // If tool url is path, join
                    const base = connection.baseUrl.replace(/\/$/, '');
                    url = `${base}${url}`;
                }

                // Inject Auth Headers. Secrets that failed to decrypt are
                // undefined here (see getConnectionWithSecrets), so no header
                // is set in that case - ciphertext never leaks into requests.
                if (connection.auth.type === 'bearer' && connection.auth.token) {
                    headers['Authorization'] = `Bearer ${connection.auth.token}`;
                } else if (connection.auth.type === 'basic' && connection.auth.username && connection.auth.password) {
                    const creds = Buffer.from(`${connection.auth.username}:${connection.auth.password}`).toString('base64');
                    headers['Authorization'] = `Basic ${creds}`;
                } else if (connection.auth.type === 'apikey' && connection.auth.apiKey && connection.auth.headerName) {
                    headers[connection.auth.headerName] = connection.auth.apiKey;
                }
            }
        }

        // Replace placeholders in URL: {key} -> URL-encoded value
        Object.entries(args).forEach(([key, value]) => {
            const placeholder = `{${key}}`;
            if (url.includes(placeholder)) {
                url = url.split(placeholder).join(encodeURIComponent(String(value)));
            }
        });

        // Handle body placeholder substitution (JSON-safe, see substituteBodyTemplate)
        if (body && (method === 'POST' || method === 'PUT')) {
            body = substituteBodyTemplate(body, args);
        }

        // Validate the final URL: http(s) only, no private/loopback targets
        let parsedUrl: URL;
        try {
            parsedUrl = new URL(url);
        } catch {
            return { success: false, error: `Invalid tool URL: ${url}` };
        }

        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            return { success: false, error: `Blocked non-http(s) URL scheme: ${parsedUrl.protocol}` };
        }

        if (!localUrlsAllowed() && isPrivateHostname(parsedUrl.hostname)) {
            return {
                success: false,
                error: `Blocked request to private/local address "${parsedUrl.hostname}". Set ALLOW_LOCAL_TOOL_URLS=1 to allow local targets (e.g. Ollama).`
            };
        }

        // Enforce a request timeout so a hanging endpoint cannot block forever
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        let response: Response;
        try {
            response = await fetch(parsedUrl.toString(), {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    ...headers,
                },
                body: method !== 'GET' ? body : undefined,
                signal: controller.signal,
            });
        } catch (fetchError) {
            if (fetchError instanceof Error && fetchError.name === 'AbortError') {
                return { success: false, error: `Tool request timed out after ${REQUEST_TIMEOUT_MS / 1000}s` };
            }
            throw fetchError;
        } finally {
            clearTimeout(timer);
        }

        if (!response.ok) {
            return {
                success: false,
                error: `API returned ${response.status}: ${response.statusText}`
            };
        }

        const data = await response.json();
        return { success: true, data };

    } catch (error) {
        console.error(`[tools] Execution of tool "${tool.name}" failed:`, error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown execution error'
        };
    }
}
