/**
 * Runs inside the sandbox: a fake workflow that waits for a human answer the way `input()` will.
 *
 * Plain JavaScript, so it runs on the sandbox's own Node without a build step. It talks to the host
 * only through files in STATE_DIR, so no connection is open while the sandbox is paused. The one
 * exception is the ticker on TICK_PORT, which exists to see what pausing does to an open stream.
 *
 *   STATE_DIR/waiting.json  written once the workflow waits: pid, token, memory checksum, stack
 *   STATE_DIR/answer.json   written by the host after resume; resolves the pending await
 *   STATE_DIR/done.json     written when the workflow finishes: what survived the pause
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

const stateDir = process.env.STATE_DIR ?? '/home/user/state';
const memoryMb = Number(process.env.STUB_MEMORY_MB ?? '256');
const tickPort = Number(process.env.TICK_PORT ?? '8080');

/** State that only survives if memory does. */
const token = randomUUID();
const ballast = Buffer.alloc(memoryMb * 1024 * 1024);
for (let offset = 0; offset < ballast.length; offset += 4096) ballast.writeUInt32LE(offset % 0xffffffff, offset);
const checksum = () => createHash('sha256').update(ballast).digest('hex');

/** Wall clock and timers across the pause: one tick per second, and a timeout due 30 s after waiting. */
const ticks = [];
setInterval(() => {
    ticks.push(Date.now());
    if (ticks.length > 3600) ticks.shift();
}, 1000).unref();

/** An open stream across the pause: the host reads one line per second from GET /ticks. */
createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    const timer = setInterval(() => response.write(`${String(Date.now())}\n`), 1000);
    request.on('close', () => { clearInterval(timer); });
}).listen(tickPort);

async function waitForFile(path) {
    for (;;) {
        try {
            return JSON.parse(await readFile(path, 'utf8'));
        } catch {
            await sleep(200);
        }
    }
}

async function input(question) {
    const timeout = { scheduledAt: Date.now(), dueAt: Date.now() + 30_000, firedAt: null };
    setTimeout(() => { timeout.firedAt = Date.now(); }, 30_000).unref();

    await writeFile(`${stateDir}/waiting.json`, JSON.stringify({
        question,
        pid: process.pid,
        token,
        memoryMb,
        checksum: checksum(),
        waitingAt: Date.now(),
        stack: new Error('waiting').stack,
    }, null, 2));

    const answer = await waitForFile(`${stateDir}/answer.json`);
    return { answer, timeout, stack: new Error('resumed').stack };
}

async function loop() {
    const before = Date.now();
    const result = await input('Approve the plan?');
    return { ...result, waitedMs: Date.now() - before };
}

async function workflow() {
    const result = await loop();
    await writeFile(`${stateDir}/done.json`, JSON.stringify({
        pid: process.pid,
        token,
        checksum: checksum(),
        answer: result.answer,
        waitedMs: result.waitedMs,
        timeout: result.timeout,
        largestTickGapMs: ticks.slice(1).reduce((largest, tick, index) => Math.max(largest, tick - (ticks[index] ?? tick)), 0),
        stack: result.stack,
        doneAt: Date.now(),
    }, null, 2));
}

await mkdir(stateDir, { recursive: true });
await workflow();
process.exit(0);
