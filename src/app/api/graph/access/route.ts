/**
 * Zugriffs-Übersicht (GRAPH_CORE_SPEC §17, M13) — Route-Adapter der Aktion
 * `access_overview`: Identität, Graphen mit Modi, Regeln, Nutzer, Gruppen,
 * Räume und der Katalog für die Oberfläche.
 */

import { respondWithAction } from '@/lib/actions/route';
import { accessOverview } from '@/lib/graph/authz/actions';

export const dynamic = 'force-dynamic';

export async function GET() {
    return respondWithAction(accessOverview, {});
}
