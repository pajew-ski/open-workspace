/**
 * Web-App-Manifest als Route statt statischer Datei (M12).
 *
 * Grund: Unter Home-Assistant-Ingress liegt die App hinter einem Präfix,
 * das erst zur Laufzeit feststeht. `start_url`, `scope`, Icon- und
 * Shortcut-Pfade müssen es tragen, sonst installiert der Browser eine PWA,
 * die auf den Wurzelpfad des Hosts zeigt — also ins Leere.
 *
 * Die Icons selbst bleiben statische Dateien unter `public/icons/`.
 */

import { withBasePath } from '@/lib/platform/base-path';

export const dynamic = 'force-dynamic';

function icon(name: string, sizes: string, purpose: 'any' | 'maskable') {
    return {
        src: withBasePath(`/icons/${name}`),
        sizes,
        type: 'image/png',
        purpose,
    };
}

function shortcut(name: string, shortName: string, description: string, url: string) {
    return {
        name,
        short_name: shortName,
        description,
        url: withBasePath(url),
        icons: [{ src: withBasePath('/icons/icon-192.png'), sizes: '192x192', type: 'image/png' }],
    };
}

export function GET() {
    const root = `${withBasePath('/')}`;
    const manifest = {
        id: root,
        name: 'Open Workspace',
        short_name: 'Open Workspace',
        description: 'Umfassender AI-Workspace für Agenten-Kollaboration',
        start_url: root,
        scope: root,
        lang: 'de',
        dir: 'ltr',
        display: 'standalone',
        background_color: '#FAFAFA',
        theme_color: '#00674F',
        orientation: 'portrait-primary',
        categories: ['productivity', 'utilities'],
        icons: [
            icon('icon-192.png', '192x192', 'any'),
            icon('icon-512.png', '512x512', 'any'),
            icon('icon-maskable-192.png', '192x192', 'maskable'),
            icon('icon-maskable-512.png', '512x512', 'maskable'),
        ],
        shortcuts: [
            shortcut('Aufgaben', 'Aufgaben', 'Aufgaben ansehen und verwalten', '/tasks'),
            shortcut('Kalender', 'Kalender', 'Termine und Kalender öffnen', '/calendar'),
            shortcut('Wissensbasis', 'Wissen', 'Dokumente und Wissensbasis öffnen', '/docs'),
        ],
    };

    return new Response(`${JSON.stringify(manifest, null, 4)}\n`, {
        headers: {
            'Content-Type': 'application/manifest+json; charset=utf-8',
            'Cache-Control': 'no-store',
        },
    });
}
