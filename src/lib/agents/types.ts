export type AgentType = 'local' | 'remote_a2a';

export interface AgentConfig {
    /** Local agents: persona/system prompt. */
    systemPrompt?: string;
    /** Local agents: model override (falls back to the workspace default). */
    model?: string;
    /** Local agents: inference provider override (id from the AI hub). */
    providerId?: string;
    /** Remote A2A agents: JSON-RPC endpoint URL (from card discovery). */
    endpointUrl?: string;
    /** Remote A2A agents: where the agent card was found. */
    cardUrl?: string;
    /** Remote A2A agents: advertised skills/capabilities (display only). */
    capabilities?: string[];
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
