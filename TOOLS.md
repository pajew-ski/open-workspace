# Agent2Agent Tools Specification

The Open Workspace provides standardized tools for agents (including the Personal Assistant) to interact with the system.

## Tool: Global Finder

This tool allows agents to fuzzy-search across the entire workspace or specific modules.

### Definition

- **Name**: `workspace_finder`
- **Description**: Search for tasks, notes, projects, chats, and calendar events.
- **Endpoint**: `GET /api/finder`
- **Parameters**:
    - `q` (string, required): The search query.
    - `type` (string, optional): One of [`task`, `note`, `project`, `chat`, `calendar`]. If omitted, searches all.

### Response Format

```json
{
  "results": [
    {
      "type": "task",
      "id": "task-123",
      "title": "Fix Login Bug",
      "subtitle": "Aufgabe • TODO • Frontend",
      "url": "/tasks?id=task-123",
      "matchScore": 2
    }
  ]
}
```

### Usage for Assistant

When the user asks to find something, you should:
1.  Identify if they mean a specific type (e.g., "Find task X").
2.  Use the `workspace_finder` tool (conceptually) or query the API if backend supports function calling.
3.  Present the results to the user.

*(Note: Currently, the Assistant backend relies on system prompt context. Future versions will implement direct function calling using this spec.)*
