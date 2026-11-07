import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.{test,spec}.ts'],
        // The conformance suite starts real sandboxes; a pause writes all memory to disk first.
        testTimeout: 120_000,
        hookTimeout: 120_000,
    },
});
