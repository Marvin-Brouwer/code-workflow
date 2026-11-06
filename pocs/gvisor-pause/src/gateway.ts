/**
 * A stand-in for the engine's gateway: an HTTP CONNECT proxy on a Unix socket that only tunnels to
 * allowed hosts. The sandbox runs with `--network=none`, so this socket, bind-mounted into it, is
 * its only way out. With HTTPS_PROXY set on the host, tunnels go through that proxy.
 */
import { createServer, request } from 'node:http';
import { connect, type Socket } from 'node:net';
import { rmSync } from 'node:fs';

function upstream(host: string, port: number): Promise<Socket> {
    const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
    if (!proxy) {
        return new Promise((resolve, reject) => {
            const socket = connect(port, host, () => { resolve(socket); });
            socket.once('error', reject);
        });
    }
    const url = new URL(proxy);
    return new Promise((resolve, reject) => {
        const tunnel = request({ host: url.hostname, port: url.port, method: 'CONNECT', path: `${host}:${String(port)}` });
        tunnel.once('connect', (response, socket) => {
            if (response.statusCode === 200) resolve(socket);
            else reject(new Error(`upstream proxy answered ${String(response.statusCode)}`));
        });
        tunnel.once('error', reject);
        tunnel.end();
    });
}

/** Starts the gateway on `socketPath`. Returns a function that stops it. */
export async function startGateway(socketPath: string, allowed: readonly string[]): Promise<{ stop(): Promise<void>; log: string[] }> {
    const log: string[] = [];
    const server = createServer((_request, response) => {
        response.writeHead(405).end('CONNECT only\n');
    });
    server.on('connect', (req, client: Socket, head) => {
        const [host = '', portText = '443'] = (req.url ?? '').split(':');
        if (!allowed.includes(host)) {
            log.push(`denied ${host}`);
            client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
            return;
        }
        log.push(`allowed ${host}`);
        upstream(host, Number(portText)).then((remote) => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            remote.write(head);
            remote.pipe(client).pipe(remote);
            remote.once('error', () => client.destroy());
            client.once('error', () => remote.destroy());
        }, (error: unknown) => {
            log.push(`failed ${host}: ${error instanceof Error ? error.message : String(error)}`);
            client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        });
    });
    rmSync(socketPath, { force: true });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    return {
        log,
        stop: () => new Promise((resolve) => {
            server.close(() => { resolve(); });
            server.closeAllConnections();
        }),
    };
}

/**
 * Runs inside the sandbox: requests https://<host>/ through the gateway socket and prints
 * `{ host: status }` as JSON, with '000' for anything that failed.
 */
export const probeScript = `
const http = require('node:http');
const tls = require('node:tls');
function probe(host) {
    return new Promise((resolve) => {
        const fail = () => resolve('000');
        const req = http.request({ socketPath: process.env.GATEWAY_SOCKET, method: 'CONNECT', path: host + ':443' });
        req.once('connect', (res, socket) => {
            if (res.statusCode !== 200) { socket.destroy(); return fail(); }
            const secure = tls.connect({ socket, servername: host }, () => {
                secure.write('HEAD / HTTP/1.1\\r\\nHost: ' + host + '\\r\\nConnection: close\\r\\n\\r\\n');
            });
            secure.setEncoding('utf8');
            secure.once('data', (text) => { resolve(text.split(' ')[1] || '000'); secure.destroy(); });
            secure.once('error', fail);
        });
        req.once('error', fail);
        req.setTimeout(10000, () => { req.destroy(); fail(); });
        req.end();
    });
}
async function direct(host) {
    try { const r = await fetch('https://' + host + '/', { signal: AbortSignal.timeout(5000) }); return String(r.status); }
    catch { return '000'; }
}
(async () => {
    const hosts = process.argv.slice(1);
    const result = {};
    for (const host of hosts) result[host] = await probe(host);
    result.direct = await direct(hosts[0]);
    console.log(JSON.stringify(result));
})();
`;
