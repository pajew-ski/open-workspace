/**
 * Ingress-Proxy für das Home-Assistant-Add-on (SPEC §5.2, M12).
 *
 * Der Supervisor liefert die App unter `/api/hassio_ingress/<token>/…` aus,
 * **entfernt dieses Präfix aber, bevor er die Anfrage an das Add-on
 * weiterreicht**, und teilt es über den Header `X-Ingress-Path` mit. Next
 * dagegen erwartet Anfragen MIT seinem `basePath` — sonst antwortet es 404.
 *
 * Dieser Proxy schließt genau diese Lücke: er setzt das Präfix wieder vor
 * den Pfad und reicht die Anfrage an den lokalen Next-Prozess weiter. Er ist
 * Teil des Packagings, nicht der Anwendung — dieselbe Anwendung, dasselbe
 * Image läuft ohne ihn als Runtime `server`.
 *
 * Rotiert der Ingress-Token (der eingesetzte Base-Path stimmt dann nicht
 * mehr mit dem Header überein), ist jede ausgelieferte URL falsch. Der Proxy
 * meldet das ehrlich mit 503 und beendet den Prozess, damit der Supervisor
 * das Add-on neu startet und der Build den neuen Pfad bekommt.
 */

import http from 'node:http';

/**
 * Präfix vor den Pfad setzen. Die Wurzel bekommt bewusst KEINEN
 * Schrägstrich angehängt: Next liefert seine Startseite unter `<basePath>`
 * aus und leitet `<basePath>/` mit 308 dorthin um — der Supervisor würde
 * daraus eine Endlosschleife machen, weil er das Präfix erneut entfernt.
 */
export function prefixed(basePath, url) {
    const [pathname, query] = url.split(/(?=\?)/, 2);
    const suffix = pathname === '/' ? '' : pathname;
    return `${basePath}${suffix}${query ?? ''}`;
}

/**
 * @param {object} options
 * @param {number} options.listenPort   Port für den Supervisor (ingress_port).
 * @param {number} options.targetPort   Port des Next-Prozesses (nur localhost).
 * @param {string} options.basePath     Eingesetzter Base-Path, z. B. /api/hassio_ingress/abc.
 * @param {(actual: string) => void} [options.onIngressPathChanged]
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<http.Server>}
 */
export function startIngressProxy({ listenPort, targetPort, basePath, onIngressPathChanged, log = () => {} }) {
    const server = http.createServer((req, res) => {
        const ingressPath = req.headers['x-ingress-path'];
        if (typeof ingressPath === 'string' && ingressPath && ingressPath.replace(/\/$/, '') !== basePath) {
            res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(
                'Der Ingress-Pfad hat sich geändert. Das Add-on startet neu, '
                + 'damit alle Links wieder stimmen — bitte die Seite gleich neu laden.\n',
            );
            log(`Ingress-Pfad geändert: erwartet ${basePath}, erhalten ${ingressPath}`);
            onIngressPathChanged?.(ingressPath);
            return;
        }

        const proxied = http.request(
            {
                host: '127.0.0.1',
                port: targetPort,
                method: req.method,
                path: prefixed(basePath, req.url ?? '/'),
                headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
            },
            upstream => {
                res.writeHead(upstream.statusCode ?? 502, upstream.headers);
                upstream.pipe(res);
            },
        );
        proxied.on('error', error => {
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            }
            res.end(`Der Workspace-Prozess ist nicht erreichbar: ${error.message}\n`);
        });
        req.pipe(proxied);
    });

    // WebSocket/Upgrade durchreichen (der Assistent nutzt heute SSE, aber ein
    // Upgrade darf nicht still im Proxy sterben).
    server.on('upgrade', (req, socket, head) => {
        const upstream = http.request({
            host: '127.0.0.1',
            port: targetPort,
            method: req.method,
            path: prefixed(basePath, req.url ?? '/'),
            headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
        });
        upstream.end();
        upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
            const headers = Object.entries(upstreamRes.headers)
                .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
                .join('\r\n');
            socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n\r\n`);
            if (upstreamHead?.length) socket.unshift(upstreamHead);
            if (head?.length) upstreamSocket.write(head);
            upstreamSocket.pipe(socket);
            socket.pipe(upstreamSocket);
        });
        upstream.on('error', () => socket.destroy());
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(listenPort, '0.0.0.0', () => {
            log(`Ingress-Proxy hört auf :${listenPort} → 127.0.0.1:${targetPort} (Base-Path ${basePath})`);
            resolve(server);
        });
    });
}
