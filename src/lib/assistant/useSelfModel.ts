'use client';

import { useQuery } from '@tanstack/react-query';
import { moduleForPath, type SelfModelView } from '@/lib/graph/meta/self-model-view';

/**
 * Selbstmodell der Installation im Client (GRAPH_CORE_SPEC §18, M14).
 *
 * Ersetzt die früher an zwei Stellen gepflegte `MODULE_CONTEXT`-Tabelle:
 * Woher der Assistent weiß, in welchem Modul der Nutzer steht und was
 * dieses Modul tut, steht jetzt im Graphen (`graph/meta`) und kommt über
 * `GET /api/graph/self-model` zurück.
 *
 * Ohne erreichbares Backend (serverloser Betrieb, SPEC §5.2) gibt es kein
 * Selbstmodell — dann ist `view` schlicht `null` und der Prompt behauptet
 * nichts über das System. Das ist der ehrliche Zustand, keine Attrappe.
 */
export function useSelfModel(): { view: SelfModelView | null; isLoading: boolean } {
    const { data, isLoading } = useQuery<SelfModelView>({
        queryKey: ['graph-self-model'],
        queryFn: async () => {
            const response = await fetch('/api/graph/self-model');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json() as Promise<SelfModelView>;
        },
        // Das Modell ändert sich nur mit dem Build der Instanz.
        staleTime: 10 * 60 * 1000,
        retry: false,
    });
    return { view: data ?? null, isLoading };
}

/** Aktuelles Modul laut Selbstmodell — `null`, solange es keines gibt. */
export function useCurrentModule(pathname: string) {
    const { view } = useSelfModel();
    return view ? moduleForPath(view.modules, pathname) : null;
}
