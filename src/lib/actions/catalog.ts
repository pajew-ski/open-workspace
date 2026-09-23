/**
 * Katalog der Aktionsmodule: die Module registrieren sich beim Laden,
 * und dieser Import sorgt dafür, dass sie geladen sind, bevor jemand die
 * Registry liest. Kein Modul, das Aktionen definiert, darf hier fehlen —
 * `tests/platform/action-parity.test.ts` vergleicht diese Liste mit
 * jeder `actions.ts` unter `src/lib/`.
 */

import '@/lib/assistant/actions';
import '@/lib/graph/mcp/actions';
import '@/lib/graph/search/actions';
import '@/lib/graph/workspace/actions';
