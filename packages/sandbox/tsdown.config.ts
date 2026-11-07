import { defineConfig } from 'tsdown';

export default defineConfig({
    entry: ['src/index.ts', 'src/e2b.ts', 'src/microsandbox.ts', 'src/gvisor.ts'],
    format: ['esm'],
    platform: 'node',
    dts: true,
    clean: true,
    sourcemap: true,
});
