import { existsSync } from 'node:fs';
import { describe, expect, onTestFinished, test } from 'vitest';
import { gvisorBackend } from '../src/gvisor/gvisor-backend.ts';
import { Layout } from '../src/gvisor/layout.ts';
import { BackendMismatchError, type PausedSandbox } from '../src/paused-sandbox.ts';
import type { SandboxBackend } from '../src/sandbox-backend.ts';
import type { SandboxSpec } from '../src/sandbox-spec.ts';
import { fakeRunsc } from './support/fake-runsc.ts';
import { temporaryDirectory } from './support/temporary-directory.ts';

const spec: SandboxSpec = { image: 'node:22-slim', cpus: 1, memoryMb: 512, egress: { allow: [] } };

async function backendOnFakeRunsc(): Promise<{ backend: SandboxBackend; directory: string; reopen: () => SandboxBackend }> {
    const directory = await temporaryDirectory();
    const runsc = await fakeRunsc(directory, spec.image);
    const open = () => gvisorBackend({ directory, runsc });
    const backend = open();
    onTestFinished(() => backend.close(AbortSignal.timeout(5000)).catch(() => undefined));
    return { backend, directory, reopen: open };
}

function timeout(): AbortSignal {
    return AbortSignal.timeout(5000);
}

describe('gVisor backend, on a fake runsc', () => {
    test('keeps the id across a pause and resume, and list follows the state', async () => {
        // Arrange
        const { backend } = await backendOnFakeRunsc();
        const sandbox = await backend.create(spec, timeout());

        // Act
        const paused = await sandbox.pause(timeout());
        const listedPaused = await backend.list(timeout());
        const resumed = await backend.resume(paused, timeout());
        const listedRunning = await backend.list(timeout());

        // Assert
        expect(paused).toMatchObject({ backend: 'gvisor', id: sandbox.id, spec });
        expect(listedPaused).toEqual([{ id: sandbox.id, state: 'paused' }]);
        expect(resumed.id).toBe(sandbox.id);
        expect(listedRunning).toEqual([{ id: sandbox.id, state: 'running' }]);
    });

    test('runs commands and returns a non-zero exit code as a result', async () => {
        // Arrange
        const { backend } = await backendOnFakeRunsc();
        const sandbox = await backend.create(spec, timeout());

        // Act
        const result = await sandbox.exec(['sh', '-c', 'echo out; echo err >&2; exit 3'], { signal: timeout() });

        // Assert
        expect(result).toEqual({ exitCode: 3, stdout: 'out\n', stderr: 'err\n' });
    });

    test('refuses to resume a pause made by another backend', async () => {
        // Arrange
        const { backend } = await backendOnFakeRunsc();
        const paused: PausedSandbox = { backend: 'microsandbox', id: 'mesh-flow-0123456789ab', spec, snapshot: 'x' };

        // Act
        const resuming = backend.resume(paused, timeout());

        // Assert
        await expect(resuming).rejects.toThrow(BackendMismatchError);
    });

    test('settles an exec that never ends as soon as its signal aborts', async () => {
        // Arrange
        const { backend } = await backendOnFakeRunsc();
        const sandbox = await backend.create(spec, timeout());
        const controller = new AbortController();
        const running = sandbox.exec(['sleep', '3600'], { signal: controller.signal });

        // Act
        controller.abort(new Error('shutting down'));

        // Assert
        await expect(running).rejects.toThrow();
    });

    test('closes while an exec never ends, and leaves nothing behind', async () => {
        // Arrange
        const { backend, directory, reopen } = await backendOnFakeRunsc();
        const sandbox = await backend.create(spec, timeout());
        const running = sandbox.exec(['sleep', '3600'], { signal: new AbortController().signal });
        running.catch(() => undefined);

        // Act
        await backend.close(timeout());

        // Assert
        await expect(running).rejects.toThrow();
        expect(await reopen().list(timeout())).toEqual([]);
        expect(existsSync(new Layout(directory).sandbox(sandbox.id).directory)).toBe(false);
    });

    test('keeps paused sandboxes on close, for the next start to find', async () => {
        // Arrange
        const { backend, reopen } = await backendOnFakeRunsc();
        const sandbox = await backend.create(spec, timeout());
        await sandbox.pause(timeout());

        // Act
        await backend.close(timeout());

        // Assert
        expect(await reopen().list(timeout())).toEqual([{ id: sandbox.id, state: 'paused' }]);
    });

    test('remove clears a paused sandbox, and refuses anything that is not a sandbox id', async () => {
        // Arrange
        const { backend } = await backendOnFakeRunsc();
        const sandbox = await backend.create(spec, timeout());
        await sandbox.pause(timeout());

        // Act
        await backend.remove(sandbox.id, timeout());

        // Assert
        expect(await backend.list(timeout())).toEqual([]);
        await expect(backend.remove('../images', timeout())).rejects.toThrow("isn't a mesh-flow sandbox id");
    });

    test('starts the egress proxy with the sandbox and stops it on pause', async () => {
        // Arrange
        const { backend, directory } = await backendOnFakeRunsc();
        const sandbox = await backend.create({ ...spec, egress: { allow: ['registry.npmjs.org'] } }, timeout());
        const socket = new Layout(directory).sandbox(sandbox.id).egressSocket;
        const listening = existsSync(socket);

        // Act
        await sandbox.pause(timeout());

        // Assert
        expect(listening).toBe(true);
        expect(existsSync(socket)).toBe(false);
    });

    test('refuses new work once closed', async () => {
        // Arrange
        const { backend } = await backendOnFakeRunsc();
        await backend.close(timeout());

        // Act
        const creating = backend.create(spec, timeout());

        // Assert
        await expect(creating).rejects.toThrow('closed');
    });
});
