import { chmod, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { connect, type Socket } from 'node:net';

export interface EgressProxy {
    /** Stops listening and ends every open tunnel. */
    close(): Promise<void>;
}

export interface EgressProxyOptions {
    readonly socketPath: string;
    /** Host names a tunnel may go to. Anything else gets a 403. */
    readonly allow: readonly string[];
    /** An HTTP proxy between this machine and the internet, as `http://host:port`. */
    readonly upstreamProxy?: string;
}

/**
 * An HTTP CONNECT proxy on a Unix socket that tunnels only to allowed hosts. A gVisor sandbox has
 * no network; this socket, bind-mounted into it, is its only way out.
 */
export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
    const tunnels = new Set<Socket>();
    const server = createServer((_request, response) => {
        response.writeHead(405).end('Only CONNECT is supported.\n');
    });
    server.on('connect', (connectRequest, client: Socket, head: Buffer) => {
        const { host, port } = parseTarget(connectRequest.url ?? '');
        if (!options.allow.includes(host)) {
            client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
            return;
        }
        tunnels.add(client);
        client.once('close', () => tunnels.delete(client));
        client.once('error', () => client.destroy());
        openUpstream(host, port, options.upstreamProxy).then(
            (remote) => {
                tunnels.add(remote);
                remote.once('close', () => tunnels.delete(remote));
                remote.once('error', () => client.destroy());
                client.once('close', () => remote.destroy());
                client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                remote.write(head);
                remote.pipe(client).pipe(remote);
            },
            () => {
                client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            },
        );
    });

    await rm(options.socketPath, { force: true });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.socketPath, resolve);
    });
    // runsc's gofer opens the socket for the sandbox. It runs as root without CAP_DAC_OVERRIDE,
    // so a socket made by another user has to be writable for everyone.
    await chmod(options.socketPath, 0o666);

    return {
        close: () => new Promise((resolve) => {
            for (const tunnel of tunnels) tunnel.destroy();
            server.close(() => {
                resolve();
            });
        }),
    };
}

function parseTarget(target: string): { host: string; port: number } {
    const separator = target.lastIndexOf(':');
    if (separator === -1) return { host: target, port: 443 };
    return { host: target.slice(0, separator), port: Number(target.slice(separator + 1)) };
}

function openUpstream(host: string, port: number, upstreamProxy: string | undefined): Promise<Socket> {
    if (upstreamProxy === undefined) {
        return new Promise((resolve, reject) => {
            const socket = connect(port, host, () => {
                resolve(socket);
            });
            socket.once('error', reject);
        });
    }
    const proxy = new URL(upstreamProxy);
    return new Promise((resolve, reject) => {
        const tunnel = request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: `${host}:${String(port)}` });
        tunnel.once('connect', (response, socket) => {
            if (response.statusCode === 200) {
                resolve(socket);
            } else {
                socket.destroy();
                reject(new Error(`The upstream proxy answered ${String(response.statusCode)}.`));
            }
        });
        tunnel.once('error', reject);
        tunnel.end();
    });
}
