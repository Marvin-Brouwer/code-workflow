import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        // The option C sketches aren't workspace members yet; pocs/loop-typing type-checks them.
        ignores: ['**/node_modules/', '**/dist/', 'examples/', 'packages/'],
    },
    eslint.configs.recommended,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        // The stubs type-check with the sketches, under bundler resolution.
        files: ['pocs/loop-typing/stubs/**/*.ts'],
        languageOptions: {
            parserOptions: {
                projectService: false,
                project: ['pocs/loop-typing/tsconfig.sketches.json'],
            },
        },
    },
    {
        // Type tests assert on `void` results by design.
        files: ['pocs/loop-typing/test/**/*.ts'],
        rules: {
            '@typescript-eslint/no-confusing-void-expression': 'off',
            '@typescript-eslint/no-invalid-void-type': 'off',
        },
    },
    {
        files: ['**/*.js', '**/*.mjs'],
        extends: [tseslint.configs.disableTypeChecked],
        languageOptions: {
            globals: globals.node,
            parserOptions: { projectService: false },
        },
    },
);
