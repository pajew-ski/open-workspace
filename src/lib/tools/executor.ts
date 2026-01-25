import { Tool } from './types';
import { getConnectionWithSecrets } from '@/lib/connections/manager';

interface ToolExecutionResult {
    success: boolean;
    data?: any;
    error?: string;
}

/**
 * Execute a tool with given arguments.
 * Arguments can be injected into URL placeholders (e.g. {lat}) or Body.
 */
export async function executeTool(tool: Tool, args: Record<string, any> = {}): Promise<ToolExecutionResult> {
    if (tool.type !== 'api') {
        return { success: false, error: 'Only API tools are currently supported' };
    }

    try {
        let url = tool.config.url || '';
        const method = tool.config.method || 'GET';
        let body = tool.config.body;
        let headers = { ...tool.config.headers };

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

                // Inject Auth Headers
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

        // Replace placeholders in URL: {key} -> value
        Object.entries(args).forEach(([key, value]) => {
            const placeholder = `{${key}}`;
            if (url.includes(placeholder)) {
                url = url.replace(placeholder, encodeURIComponent(String(value)));
            }
        });

        // If GET and args remain, append as query params? 
        // For simplicity, we assume generic API tools define everything in URL or let user pass full query string if needed.
        // But for "Weather API", user might pass latitude/longitude as args.

        // Handle Body replacement if POST
        if (body && (method === 'POST' || method === 'PUT')) {
            Object.entries(args).forEach(([key, value]) => {
                body = body!.replace(`{${key}}`, String(value));
            });
        }

        const response = await fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...headers,
            },
            body: method !== 'GET' ? body : undefined,
        });

        if (!response.ok) {
            return {
                success: false,
                error: `API returned ${response.status}: ${response.statusText}`
            };
        }

        const data = await response.json();
        return { success: true, data };

    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown execution error'
        };
    }
}
