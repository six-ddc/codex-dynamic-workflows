import assert from "node:assert/strict";
import childProcess, { type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runWorkflow, ScriptedAgentRunner } from "../src/index.js";

const PREFIX = "__CODEX_WORKFLOW_IPC__";
const TEXT = "é漢🧪";
const SCRIPT = "export const meta = { name: 'unicode', description: 'Synthetic transport fixture' }; return null";

// Each continuation byte starts a new chunk, splitting every 2-, 3- and 4-byte character.
function writeFragmented(stream: PassThrough, text: string): void {
  const bytes = Buffer.from(text);
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    if ((bytes[index]! & 0xc0) === 0x80) {
      stream.write(bytes.subarray(start, index));
      start = index;
    }
  }
  stream.write(bytes.subarray(start));
}

function controlledChild() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout, stderr, stdin, killed: false, exitCode: null, signalCode: null,
    kill() { this.killed = true; return true; },
  });
  const send = (message: unknown) => writeFragmented(stdout, PREFIX + JSON.stringify(message) + "\n");
  return { child: child as unknown as ChildProcessWithoutNullStreams, stdout, stderr, stdin, send };
}

test("Bun IPC preserves fragmented UTF-8 in large agent and nested requests, events and results", async (t) => {
  const large = TEXT.repeat(10000);
  const children: ReturnType<typeof controlledChild>[] = [];
  const prompts: unknown[] = [];
  const runnerSources: string[] = [];
  const resolutions: unknown[] = [];
  t.mock.method(childProcess, "spawn", ((_command: string, args: string[]) => {
    runnerSources.push(readFileSync(args[0]!, "utf8"));
    const child = controlledChild();
    const index = children.push(child) - 1;
    queueMicrotask(() => {
      if (index === 0) {
        let buffer = "";
        const responses: unknown[] = [];
        child.stdin.setEncoding("utf8");
        child.stdin.on("data", (chunk: string) => {
          buffer += chunk;
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            responses.push(JSON.parse(line.slice(PREFIX.length)));
          }
          if (responses.length === 2) child.send({ kind: "result", value: { text: large, responses } });
        });
        // Several JSONL messages share a stream; large messages exceed ordinary pipe chunk sizes.
        writeFragmented(child.stdout, `${TEXT}\n`);
        child.send({ kind: "event", type: "phase", payload: { title: TEXT } });
        child.send({ kind: "event", type: "log", payload: { message: TEXT } });
        child.send({ kind: "request", id: 1, type: "agent", payload: { prompt: large, options: { label: TEXT } } });
        child.send({ kind: "request", id: 2, type: "workflow", payload: { nameOrRef: TEXT, args: { text: large }, depth: 0 } });
      } else {
        child.send({ kind: "result", value: { nested: TEXT } });
      }
    });
    return child.child;
  }) as unknown as typeof childProcess.spawn);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  const result = await runWorkflow<{ text: string; responses: { id: number; value: unknown }[] }>(SCRIPT, {
    runner: new ScriptedAgentRunner(call => { prompts.push({ prompt: call.prompt, label: call.options.label }); return TEXT; }),
    resolveWorkflow: async (name) => { resolutions.push(name); return { name: TEXT, script: SCRIPT }; },
  });
  assert.deepEqual(prompts, [{ prompt: large, label: TEXT }]);
  assert.deepEqual(resolutions, [TEXT]);
  assert.equal(result.result.text, large);
  assert.deepEqual(result.result.responses.sort((a, b) => a.id - b.id).map(row => row.value), [TEXT, { nested: TEXT }]);
  assert.deepEqual(result.phases, [TEXT]);
  assert.deepEqual(result.logs, [TEXT, TEXT]);
  assert.equal(children.length, 2);
  assert(runnerSources[1]!.includes(`const args = ${JSON.stringify({ text: large })};`));
});

test("Bun IPC decodes fragmented UTF-8 stderr before retaining the failure tail and logs", async (t) => {
  t.mock.method(childProcess, "spawn", (() => {
    const child = controlledChild();
    queueMicrotask(() => {
      writeFragmented(child.stderr, TEXT + "\n");
      child.child.emit("exit", 1, null);
    });
    return child.child;
  }) as unknown as typeof childProcess.spawn);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const logs: string[] = [];
  await assert.rejects(runWorkflow(SCRIPT, { runner: new ScriptedAgentRunner(() => "unused"), onProgress: event => { if (event.type === "log") logs.push(event.message); } }),
    (error: Error) => { assert.equal(error.message, `Bun workflow failed: ${TEXT}`); return true; });
  assert.equal(logs.map(line => line.replace(/^\[stderr\] /, "")).join(""), TEXT);
});

test("real Bun preserves Unicode across large agent requests, nested workflows and results", async () => {
  const large = TEXT.repeat(100000);
  const seen: unknown[] = [];
  const result = await runWorkflow<{ text: string; nested: unknown }>(`export const meta = { name: 'unicode_parent', description: 'Unicode round trip' }
phase(args.label)
log(args.label)
const text = await agent(args.text, { label: args.label })
const nested = await workflow('unicode_child', { text })
return { text, nested }
`, {
    args: { text: large, label: TEXT },
    runner: new ScriptedAgentRunner(call => { seen.push(call.prompt); return call.prompt; }),
    resolveWorkflow: async () => ({ name: "unicode_child", script: `export const meta = { name: 'unicode_child', description: 'Unicode nested round trip' }; return await agent(args.text)` }),
  });
  assert.deepEqual(seen, [large, large]);
  assert.deepEqual(result.result, { text: large, nested: large });
  assert.deepEqual(result.phases, [TEXT]);
  assert.deepEqual(result.logs, [TEXT]);
});
