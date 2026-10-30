/**
 * Checks what an editor shows on hover for `loop` results in the reference workflow: the resolved
 * type, not `ResultOf<[…]>`. Uses the same language service call as an editor's hover.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const workflow = path.resolve(root, '../../examples/example/workflows/develop.ts');

/** Variables in develop.ts holding a `loop` result, and what hovering them must show. */
const expectations: { variable: string; shows: (display: string) => boolean; expected: string }[] = [
    { variable: 'research', shows: (display) => display === 'const research: WorkspaceFolder', expected: 'WorkspaceFolder' },
    {
        variable: 'plan',
        shows: (display) => display.startsWith('const plan: {') && display.includes('repositories:'),
        expected: 'the Plan object type',
    },
];

const configPath = path.join(root, 'tsconfig.sketches.json');
const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
});
if (!config) throw new Error(`Can't read ${configPath}`);

const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => config.options,
    getScriptFileNames: () => config.fileNames,
    getScriptVersion: () => '1',
    getScriptSnapshot: (fileName) => ts.sys.fileExists(fileName)
        ? ts.ScriptSnapshot.fromString(readFileSync(fileName, 'utf8'))
        : undefined,
    getCurrentDirectory: () => root,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (fileName) => ts.sys.fileExists(fileName),
    readFile: (fileName) => ts.sys.readFile(fileName),
    readDirectory: (directory, extensions, exclude, include, depth) =>
        ts.sys.readDirectory(directory, extensions, exclude, include, depth),
};
const service = ts.createLanguageService(host);
const source = readFileSync(workflow, 'utf8');

let failed = false;
for (const { variable, shows, expected } of expectations) {
    const position = source.indexOf(`const ${variable} = await`) + 'const '.length;
    if (position < 'const '.length) throw new Error(`No 'const ${variable} = await' in ${workflow}`);

    const info = service.getQuickInfoAtPosition(workflow, position);
    const display = ts.displayPartsToString(info?.displayParts).replace(/\s+/g, ' ');
    const ok = shows(display) && !display.includes('ResultOf');
    failed ||= !ok;
    console.log(`${ok ? 'ok  ' : 'FAIL'} hover ${variable}: ${display}${ok ? '' : ` (expected ${expected})`}`);
}

if (failed) process.exit(1);
