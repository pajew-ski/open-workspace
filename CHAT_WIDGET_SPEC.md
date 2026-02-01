# Assistant Chat Widget Specification

**Component**: `src/components/assistant/AssistantChat.tsx`
**Purpose**: The central interface for user-agent interaction, handling streaming text, UI component rendering (A2UI), context awareness, and history management.

## 1. Core UX Behaviors

### 1.1 Messaging & Streaming
- **User Message**:
  - **Action**: User types and sends.
  - **Behavior**: Input clears immediately. Message appends to list.
  - **Scroll**: Viewport MUST scroll to the **bottom** instantly to show the sent message.
- **Agent Response (Streaming)**:
  - **Start**: Agent begins typing (streaming chunks).
  - **Scroll (CRITICAL)**: Viewport MUST jump to align the **TOP** of the new agent message with the **TOP** of the chat view.
  - **During Stream**: Viewport SHOULD NOT auto-scroll to bottom. It must stay anchored to the top of the message so the user can read as text appears.
  - **Manual Scroll**: User can manually scroll down. If they do, the "stick-to-top" anchor is released.
  - **Completion**: When streaming ends, the viewport MUST NOT jump. It should stay where the user is looking (typically having read down, or still at the top).

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
| **Streaming Text** | ✅ | Real-time text rendering via `StreamChunk`. |
| **A2UI Rendering** | ✅ | Renders interactive components (buttons, forms) embedded in chat. |
| **Markdown** | ✅ | Supports GFM (tables, code blocks). |
| **Mermaid** | ✅ | Renders diagrams dynamically. |
| **Context** | ✅ | Sends current route, selection, and Copilot state to backend. |
| **Slash Commands** | ❌/⚠️ | (To be verified) Specialized commands. |
| **Optimistic UI** | ✅ | User message appears immediately. |

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

## 4. Known Regressions (To Fix)
1.  **"The Squeeze"**: New messages appearing squashed at the top before layout stabilizes.
2.  **"The Jump Down"**: Chat jumping to bottom after streaming finishes, causing user to lose reading position.
3.  **Spacer Jitters**: Conditional rendering of the spacer causes layout shifts. (Proposed fix: Permanent CSS padding).

## 5. Architecture
- **State Mcm**: `useState` + `refs` for high-frequency updates (scroll tracking).
- **Backend**: `/api/chat` (Standard) + `/api/copilotkit` (Context).
- **Styling**: modular CSS (`AssistantChat.module.css`).

---
*True Source of Usage Definition for the Assistant Chat.*
