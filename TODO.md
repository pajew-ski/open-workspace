# TODO - Open Workspace Development

## Phase 1: Foundation

### Project Setup
- [ ] Initialize Next.js 14 with App Router
- [ ] Configure TypeScript strict mode
- [ ] Set up CSS Modules with design tokens
- [ ] Configure ESLint and Prettier
- [ ] Create PWA manifest and service worker shell

### Design System
- [ ] Define color palette (neutrals + #00674F accent)
- [ ] Create typography scale
- [ ] Implement theme provider (light/dark/system)
- [ ] Build base UI components (Button, Input, Card, etc.)

### Internationalization
- [ ] Set up i18n with next-intl or similar
- [ ] Create German translation file (default)
- [ ] Create English translation file
- [ ] Implement language switcher in settings

---

## Phase 2: Core Modules

### Layout Shell
- [ ] Main navigation structure
- [ ] Global search bar (top)
- [ ] Notification bell (top right)
- [ ] Module container with consistent spacing

### Dashboard Module
- [x] Dashboard page layout
- [x] Activity feed component
- [x] Quick stats widgets
- [x] Recent items list
- [x] Chat widget integration

### Knowledge Base Module
- [ ] Knowledge base page layout
- [ ] Note list with filtering
- [ ] Markdown editor component
- [ ] Mermaid diagram renderer
- [ ] Code syntax highlighting
- [ ] Artifact management
- [ ] Module search functionality
- [ ] Add artifact button (+)
- [ ] Chat widget integration

### Canvas Module
- [ ] Canvas page layout
- [ ] Draggable card components
- [ ] Connection lines between cards
- [ ] Card creation (+) widget
- [ ] Module search functionality
- [ ] Chat widget integration

### Tasks Module
- [x] Tasks page layout
- [x] Task list with status (open/in-progress/done)
- [x] Project grouping
- [x] Priority levels
- [x] Due dates and reminders
- [x] Task filtering and sorting
- [x] Add task (+) widget
- [x] Chat widget integration

---

## Phase 3: AI Integration and Data Layer

### Data Layer
- [ ] JSON file store implementation (data/)
- [ ] Zod schemas for validation
- [ ] Notes CRUD operations
- [ ] Artifacts CRUD operations
- [ ] Canvas data operations
- [ ] Chat history persistence
- [ ] Tasks data operations

### GitHub Sync
- [ ] GitHub OAuth integration
- [ ] Repository selection
- [ ] Sync notes to GitHub
- [ ] Sync code artifacts
- [ ] Pull changes from GitHub
- [ ] Conflict resolution

### Inference Client
- [x] Ollama/Hybrid API client implementation
- [x] Streaming response handler
- [x] Error handling and retry logic
- [x] Model configuration management (Env vars)

### A2A Protocol
- [ ] Agent card schema
- [ ] Task management endpoints
- [ ] Capability discovery
- [ ] Multi-agent routing

### A2UI Protocol
- [ ] Component catalog definition
- [ ] A2UI message parser
- [ ] React renderer for A2UI components
- [ ] Streaming UI updates

### Chat Widget
- [x] Base chat component
- [x] Message list with markdown
- [x] Input with send action
- [x] Context injection per module
- [x] Streaming response display

### MCP Protocol
- [ ] MCP server implementation
- [ ] Tool definitions
- [ ] Resource handlers

---

## Phase 4: Offline and PWA

### Service Worker
- [ ] Cache strategy for static assets
- [ ] API response caching
- [ ] Background sync for pending actions
- [ ] Push notification support (later)

### IndexedDB Storage
- [ ] Notes persistence
- [ ] Canvas state persistence
- [ ] Chat history storage
- [ ] Settings sync

### PWA Configuration
- [ ] Complete manifest.json
- [ ] App icons (all sizes)
- [ ] Splash screens
- [ ] Install prompt handling

---

## Phase 5: Polish

### Settings Module
- [x] Theme selection (light/dark/system)
- [ ] Language selection (de/en)
- [x] AI endpoint configuration
- [x] Model selection
- [ ] Notification preferences

### Search
- [x] Global search implementation
- [x] Module-specific search
- [x] Search result highlighting
- [x] Keyboard shortcuts (Cmd+K/Cmd+F)
- [x] Fuzzy search & Modifiers

### Notifications
- [ ] Notification center component
- [ ] Event types and priorities
- [ ] Read/unread state
- [ ] Notification actions

### Accessibility
- [ ] Keyboard navigation
- [ ] Screen reader support
- [ ] Focus management
- [ ] Reduced motion support

---

## Backlog

- [ ] Export/import functionality
- [ ] Version history for notes
- [ ] Collaborative editing (future)
- [x] Additional AI providers (Groq/OpenAI)
- [ ] Plugin/extension system
- [x] Mobile-optimized views (Sidebar Overlay)
- [ ] GitLab sync support

---

*Last updated: 2026-01-24*
