# Architecture: Scalable Agent Ecosystem

## Goal
Design a robust system for managing Local (internal) and Remote (external) Agents, utilizing the new Credential Management system.

## 1. Local Agents
Local agents run within the Open Workspace Node.js/Browser runtime.
- **Definition**: stored in `data/agents/config.json` with `type: 'local'`.
- **Configuration**:
  - `systemPrompt`: The persona/instructions.
  - `model`: Specific model override (optional, defaults to system default).
  - `tools`: Whitelist of enabled tools (e.g., `['workspace_finder', 'weather_api']`).
- **Execution**:
  - Uses the centralized `inference/ollama` client.
  - Context is managed by the main app (similar to the Personal Assistant).
- **Use Cases**: "Research Assistant", "Coding Buddy", "Poet".

## 2. Remote Agents (A2A)
Remote agents run on external servers (Python, another Next.js app, etc.) and communicate via A2A.
- **Definition**: stored in `data/agents/config.json` with `type: 'remote_a2a'`.
- **Configuration**:
  - `connectionId`: Links to a **Secure Connection** (BaseURL + Auth).
- **Protocol**:
  - **Handshake**: `GET /capabilities` (What can you do?).
  - **Chat**: `POST /chat` (Standard A2A message format).
  - **Streaming**: Server-Sent Events (SSE).
- **Security**:
  - Use `Connection` headers for auth.
  - No secrets stored in Agent config (only references).

## 3. Integration Plan
### Backend Changes
- **AgentExecutor**: A service that decides *how* to route a message based on Agent Type.
  - `if (type === 'local') -> executeLocalInference(prompt, context)`
  - `if (type === 'remote') -> forwardToConnection(connectionId, message)`

### Frontend Changes
- **Agent Chat Interface**: Allow opening a chat specifically with ONE agent (Direct Message).
- **Group Chat**: Allow `@mentioning` agents in a room.

## 4. Future: "Agent Containers" (Docker)
For local power-users, we can support Docker-based agents managed by the app.
- `type: 'docker'`
- Config: `image`, `port_bindings`, `env_vars`.
- The app manages the container lifecycle (Start/Stop).
