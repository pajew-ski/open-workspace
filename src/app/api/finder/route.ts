/**
 * Global Finder — Route-Adapter der Aktion `workspace_finder`
 * (ACTIONS_SPEC §3). Die Suche selbst steht in
 * `src/lib/graph/search/actions.ts`; hier wird nur die Query-Form der
 * Anfrage auf die Eingabe der Aktion abgebildet.
 */

import { respondWithAction } from '@/lib/actions/route';
import { workspaceFinder } from '@/lib/graph/search/actions';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    return respondWithAction(workspaceFinder, {
        q: searchParams.get('q') ?? '',
        ...(searchParams.get('type') ? { type: searchParams.get('type') } : {}),
    });
}
