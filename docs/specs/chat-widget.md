# Assistant Chat Widget Specification

**Component**: `src/components/assistant/AssistantChat.tsx`
**Purpose**: The central interface for user-agent interaction, handling streaming text, UI component rendering (A2UI), context awareness, and history management.

## 1. Core UX Behaviors

### 1.1 Messaging & Streaming
- **User Message**:
  - **Action**: User types and sends.
  - **Behavior**: Input clears immediately. Message appends to list.
  - **Scroll**: Viewport MUST scroll to the **bottom** instantly to show the sent message.
- **Agent Response (Streaming)** — "Fill then Anchor", decided by the height
  of the growing message (`useChatScroll`):
  - **Short answer** (fits the viewport): the view follows the bottom, the
    way a chat is expected to behave. Jumping to the top here would leave
    the answer floating against empty space.
  - **Long answer** (taller than the viewport): the view anchors the TOP of
    the agent message to the top of the chat, so the beginning is never
    cut off while text keeps arriving.
  - **Manual Scroll**: scrolling down releases the anchor; it only snaps
    back when the reader has scrolled past the start of the message.
  - **Completion**: when streaming ends, the viewport MUST NOT jump.

### 1.2 Layout & Spacing
- **Spacer**: **Removed**. The message list should just fill naturally.
  - *Correction*: If a message is short, it stays at the bottom. We do NOT force it to the top with artificial spacing.
  - "Jump to Top" logic still applies for *long* or *streaming* messages where the content would overflow.
- **Resize**: The chat window is resizable (edges/corners). Content must reflow without losing scroll position.
- **Mobile**: Full-screen on mobile (<768px).

### 1.3 History & Persistence
- **Cross-Site Persistence (CRITICAL)**:
  - **Widget State**: When user navigates (e.g., /dashboard -> /tasks), the widget's open/close state, position, and size MUST persist.
  - **Scroll Position**: The scroll position within the chat MUST persist across navigation. The chat should not "reset" or jump.
  - **Context Awareness**: The Agent (and Widget) MUST detect the route change and understand the new context (e.g., "User is now looking at Tasks").

### 1.4 Loading History
- **Action**: User opens the chat or switches conversations.
- **Scroll**: Viewport MUST restore to the **BOTTOM** (most recent messages) initially.
  - **Scroll Restoration**: If returning to a previously open chat, ideally restore the *last known scroll position* (nice to have, but bottom is default).
- **State**:
  - `isOpen`, `position`, `size`: Persisted in `localStorage`.
  - `activeConversation`: Persisted.

## 2. Feature Capability Matrix

| Feature | Status | Description |
| :--- | :--- | :--- |
| **Streaming Text** | gebaut | Real-time text rendering via `StreamChunk`. |
| **A2UI Rendering** | gebaut | Renders interactive components (buttons, forms) embedded in chat. |
| **MCP-UI** | gebaut | `ui://` resources delivered by MCP tools render on the stage (sandboxed iframe). |
| **Markdown** | gebaut | Supports GFM (tables, code blocks). |
| **Mermaid** | gebaut | Renders diagrams dynamically. |
| **Context** | gebaut | Sends current route and view state; the SELF MODEL is read server-side from the graph, never taken from the request body. |
| **Model picker** | gebaut | Provider and model per turn, with the routing badge (browser-direct vs. server route). |
| **Live region** | gebaut | Transcript is `role="log"`; `aria-busy` holds announcements back while streaming, a visually hidden status line says what is happening. |
| **Optimistic UI** | gebaut | User message appears immediately. |
| **Slash Commands** | nicht gebaut | Kein Befehlsvokabular im Eingabefeld — was der Assistent kann, kommt über Tools und Skills. |

## 3. Technical Constraints & Logic

### 3.1 Scroll Logic (The "Anti-Gravity" Problem)
- **Challenge**: Standard chat interfaces "glue" to the bottom. We need "glue to top" ONLY for the *active* agent response.
- **Implementation Rules**:
  1.  **Do NOT** blindly `scrollIntoView(bottom)` on every render.
  2.  **Tracking**: Use `lastScrolledMessageId` to trigger the "Jump to Top" strictly ONCE per new agent message.
  3.  **Conflict**: Ensure `smooth` scroll doesn't conflict with "instant" updates (React renders). Use `auto` for mechanical jumps.

### 3.2 Hydration & SSR
- **Warning**: `suppressHydrationWarning` is active on `<body>`.
- **Goal**: Move towards clean hydration by using `useEffect` for all `localStorage` reads (already partially implemented).

## 4. Formerly Known Regressions

The three regressions this section used to list ("The Squeeze", "The Jump
Down", "Spacer Jitters") all had the same root cause: an artificial spacer
plus an unconditional jump-to-top. Both are gone — the spacer was removed
and the jump became the height-dependent "Fill then Anchor" rule in §1.1.
The section stays as a warning: reintroducing a spacer brings all three
back at once.

## 5. Architecture
- **State**: `useState` + `refs` for high-frequency updates (scroll tracking).
- **Backend**: `/api/chat` — or no backend at all. The same engine runs in
  the browser when a provider resolves to the browser route (local models,
  browser-stored keys, serverless operation); see
  [docs/ai-platform.md](../ai-platform.md).
- **Styling**: modular CSS (`AssistantChat.module.css`).
- **Full-page sibling**: `/assistant` (`src/app/assistant/FullPageAssistant.tsx`)
  shares the engine, the conversations and the stage. Behavioural rules
  that concern the transcript (scroll, live region) apply to both; window
  rules (resize, drag, fullscreen) only to the widget.

---
*True Source of Usage Definition for the Assistant Chat.*
