import { Tool } from './types';

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
        const headers = { ...tool.config.headers };

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
