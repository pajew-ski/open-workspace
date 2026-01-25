export type ToolType = 'api' | 'mcp';

export interface ToolConfig {
    url?: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    headers?: Record<string, string>;
    body?: string; // JSON string or template
}

export interface Tool {
    id: string;
    name: string;
    description: string;
    type: ToolType;
    connectionId?: string; // Link to a saved Connection
    config: ToolConfig;
    enabled: boolean;
    createdAt: string;
}

export interface CreateToolRequest {
    name: string;
    description: string;
    type: ToolType;
    config: ToolConfig;
}
