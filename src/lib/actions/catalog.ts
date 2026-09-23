/**
 * Katalog der Aktionsmodule: die Module registrieren sich beim Laden,
 * und dieser Import sorgt dafür, dass sie geladen sind, bevor jemand die
 * Registry liest. Kein Modul, das Aktionen definiert, darf hier fehlen —
 * `tests/platform/action-parity.test.ts` vergleicht diese Liste mit
 * jeder `actions.ts` unter `src/lib/`.
 */

import '@/lib/agents/actions';
import '@/lib/ai/actions.server';
import '@/lib/app/actions';
import '@/lib/assistant/actions';
import '@/lib/connections/actions';
import '@/lib/graph/authz/actions';
import '@/lib/graph/causal/actions.server';
import '@/lib/graph/connectors/actions';
import '@/lib/graph/federation/actions';
import '@/lib/graph/mcp/actions';
import '@/lib/graph/mcp/actions.server';
import '@/lib/graph/meta/actions';
import '@/lib/graph/observations/actions.server';
import '@/lib/graph/onboarding/actions';
import '@/lib/graph/reasoning/actions';
import '@/lib/graph/search/actions';
import '@/lib/graph/views/actions.server';
import '@/lib/graph/workspace/actions';
import '@/lib/skills/actions.server';
import '@/lib/tools/actions';
