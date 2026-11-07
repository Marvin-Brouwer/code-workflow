import { describe, expect, test } from 'vitest';
import { assertPausedBy, BackendMismatchError, PausedSandbox } from '../src/paused-sandbox.ts';

const paused: PausedSandbox = {
    backend: 'gvisor',
    id: 'mesh-flow-0123456789ab',
    spec: { image: 'node:22-slim', cpus: 1, memoryMb: 1024, egress: { allow: [] } },
    snapshot: 'mhol3k2',
};

function catchError(work: () => void): unknown {
    try {
        work();
    } catch (error) {
        return error;
    }
    return undefined;
}

describe('PausedSandbox', () => {
    test('reads back what was written as JSON', () => {
        // Act
        const parsed = PausedSandbox.parse(JSON.parse(JSON.stringify(paused)));

        // Assert
        expect(parsed).toEqual(paused);
    });

    test('refuses a backend it does not know', () => {
        // Act
        const result = PausedSandbox.safeParse({ ...paused, backend: 'docker' });

        // Assert
        expect(result.success).toBe(false);
    });
});

describe('assertPausedBy', () => {
    test('accepts a pause made by the same backend', () => {
        // Assert
        expect(() => {
            assertPausedBy(paused, 'gvisor');
        }).not.toThrow();
    });

    test('refuses a pause made by another backend, naming both', () => {
        // Act
        const error = catchError(() => {
            assertPausedBy(paused, 'microsandbox');
        });

        // Assert
        expect(error).toBeInstanceOf(BackendMismatchError);
        expect(error).toHaveProperty('message', 'This sandbox was paused by gvisor and can only be resumed there, not on microsandbox.');
    });
});
