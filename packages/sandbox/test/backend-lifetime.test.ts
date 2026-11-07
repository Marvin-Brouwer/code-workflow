import { describe, expect, test, vi } from 'vitest';
import { BackendLifetime } from '../src/backend-lifetime.ts';

describe('BackendLifetime', () => {
    test('aborts the signals it handed out when it closes', async () => {
        // Arrange
        const lifetime = new BackendLifetime();
        const signal = lifetime.signal(new AbortController().signal);

        // Act
        await lifetime.close(AbortSignal.timeout(1000));

        // Assert
        expect(signal.aborted).toBe(true);
    });

    test('follows the caller signal too', () => {
        // Arrange
        const lifetime = new BackendLifetime();
        const caller = new AbortController();
        const signal = lifetime.signal(caller.signal);

        // Act
        caller.abort();

        // Assert
        expect(signal.aborted).toBe(true);
    });

    test('removes every tracked sandbox on close, but not untracked ones', async () => {
        // Arrange
        const lifetime = new BackendLifetime();
        const removeRunning = vi.fn(() => Promise.resolve());
        const removePaused = vi.fn(() => Promise.resolve());
        lifetime.track('running', removeRunning);
        lifetime.track('paused', removePaused);
        lifetime.untrack('paused');

        // Act
        await lifetime.close(AbortSignal.timeout(1000));

        // Assert
        expect(removeRunning).toHaveBeenCalledOnce();
        expect(removePaused).not.toHaveBeenCalled();
    });

    test('removes the others when one removal fails, then reports the failure', async () => {
        // Arrange
        const lifetime = new BackendLifetime();
        const removeOther = vi.fn(() => Promise.resolve());
        lifetime.track('broken', () => Promise.reject(new Error('gone wrong')));
        lifetime.track('other', removeOther);

        // Act
        const closing = lifetime.close(AbortSignal.timeout(1000));

        // Assert
        await expect(closing).rejects.toThrow(AggregateError);
        expect(removeOther).toHaveBeenCalledOnce();
    });

    test('refuses new work once closed', async () => {
        // Arrange
        const lifetime = new BackendLifetime();
        await lifetime.close(AbortSignal.timeout(1000));

        // Act
        const start = () => lifetime.signal(new AbortController().signal);

        // Assert
        expect(start).toThrow('closed');
    });
});
