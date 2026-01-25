export type ConnectionType = 'rest' | 'mcp' | 'oauth';

export interface AuthConfig {
    type: 'bearer' | 'basic' | 'apikey' | 'none';
    // For local storage, these will be encrypted strings.
    // For env vars, these will be keywords like "ENV:MY_VAR"
    token?: string;
    username?: string;
    password?: string;
    apiKey?: string;
    headerName?: string; // e.g. "X-API-Key"
}

export interface Connection {
    id: string;
    name: string;
    description?: string;
    type: ConnectionType;
    baseUrl?: string;
    auth: AuthConfig;
    createdAt: string;
    updatedAt: string;
}

export interface CreateConnectionRequest {
    name: string;
    description?: string;
    type: ConnectionType;
    baseUrl?: string;
    auth: AuthConfig;
}
