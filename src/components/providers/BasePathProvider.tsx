'use client';

import { installBasePathFetch } from '@/lib/platform/base-path';

/**
 * Installiert den Base-Path-Filter für `fetch` (SPEC §5.2, M12) — die EINE
 * Stelle, an der die App den Ingress-Präfix kennt.
 *
 * Bewusst im Modul-Scope und nicht in einem Effekt: Der Filter muss stehen,
 * bevor irgendeine Komponente ihren ersten Datenabruf startet. Ohne
 * Base-Path ist der Aufruf ein No-Op, im Server-Rendering ebenfalls.
 */
installBasePathFetch();

export function BasePathProvider({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
}
