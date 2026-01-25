export type AgentType = 'local' | 'remote_a2a';

export interface AgentConfig {
    systemPrompt?: string;
    model?: string;
}

export interface Agent {
    id: string;
    name: string;
    description: string;
    type: AgentType;
    connectionId?: string; // Link to a Secure Connection
    config: AgentConfig;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface CreateAgentRequest {
    name: string;
    description: string;
    type: AgentType;
    connectionId?: string;
    config: AgentConfig;
}
