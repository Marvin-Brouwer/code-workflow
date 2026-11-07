import { describe, expect, test } from 'vitest';
import { snapshotName, sandboxIdOfSnapshot } from '../src/microsandbox/snapshot-name.ts';
import { assertSandboxId, isSandboxId, newSandboxId } from '../src/sandbox-id.ts';

describe('sandbox ids', () => {
    test('a new id is recognised as one', () => {
        // Act
        const id = newSandboxId();

        // Assert
        expect(isSandboxId(id)).toBe(true);
    });

    test.each(['../../etc', 'mesh-flow-0123456789ab/..', 'other-0123456789ab', ''])('refuses %j', (id) => {
        // Act
        const check = () => {
            assertSandboxId(id);
        };

        // Assert
        expect(check).toThrow("isn't a mesh-flow sandbox id");
    });
});

describe('microsandbox snapshot names', () => {
    test('lead back to the sandbox they were taken of', () => {
        // Arrange
        const id = newSandboxId();

        // Act
        const owner = sandboxIdOfSnapshot(snapshotName(id));

        // Assert
        expect(owner).toBe(id);
    });

    test.each([null, 'wait-1730000000', 'mesh-flow-0123456789ab', 'mesh-flow-0123456789abc-x'])('belong to no sandbox when named %j', (name) => {
        // Act
        const owner = sandboxIdOfSnapshot(name);

        // Assert
        expect(owner).toBeUndefined();
    });
});
