// Unit tests for the pure (vscode-free) logic modules. Run with `npm test`.
// Uses Node's built-in test runner — no extra dependencies. Tests run against
// the compiled output in ../out, so run `npm run compile` first.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

const { inferModelLimit, modelLimitFromMessages, DEFAULT_MODEL_LIMIT } = require("../out/core/modelLimits");
const { inferPricing, messageCost, sessionCostUsd } = require("../out/core/pricing");
const { CodexAdapter } = require("../out/adapters/codex");
const { HandoffGenerator } = require("../out/handoff/ruleBased");
const { createQuotaAlertState, nextQuotaAlert } = require("../out/core/quotaAlert");
const { JsonlTailReader } = require("../out/core/jsonlTail");
const { ClaudeCodeAdapter } = require("../out/adapters/claudeCode");

test("inferModelLimit: Opus/Sonnet 4.5+ are 1M", () => {
  assert.equal(inferModelLimit("claude-opus-4-8"), 1_000_000);
  assert.equal(inferModelLimit("claude-opus-4-5"), 1_000_000);
  assert.equal(inferModelLimit("claude-sonnet-4-6"), 1_000_000);
});

test("inferModelLimit: Haiku and older are 200k", () => {
  assert.equal(inferModelLimit("claude-haiku-4-5"), 200_000);
  assert.equal(inferModelLimit("claude-opus-4-1"), 200_000);
  assert.equal(inferModelLimit("claude-opus-4-0"), 200_000);
});

test("inferModelLimit: explicit [1m] tag wins", () => {
  assert.equal(inferModelLimit("claude-sonnet-4-5[1m]"), 1_000_000);
});

test("inferModelLimit: unknown/undefined falls back to default", () => {
  assert.equal(inferModelLimit(undefined), DEFAULT_MODEL_LIMIT);
  assert.equal(inferModelLimit("some-future-model"), DEFAULT_MODEL_LIMIT);
});

test("modelLimitFromMessages: uses the newest message that carries a model", () => {
  const msgs = [
    { metadata: { model: "claude-opus-4-1" } }, // 200k
    { metadata: {} },
    { metadata: { model: "claude-opus-4-8" } }, // 1M — newest wins
  ];
  assert.equal(modelLimitFromMessages(msgs), 1_000_000);
});

test("modelLimitFromMessages: explicit contextWindow (Codex) wins over model inference", () => {
  const msgs = [
    { metadata: { model: "claude-opus-4-8" } }, // would infer 1M
    { metadata: { contextWindow: 258400 } },    // provider-reported wins
  ];
  assert.equal(modelLimitFromMessages(msgs), 258400);
});

test("inferPricing: family detection", () => {
  assert.deepEqual(inferPricing("claude-opus-4-8"), { inputPerMTok: 5, outputPerMTok: 25 });
  assert.deepEqual(inferPricing("claude-sonnet-4-6"), { inputPerMTok: 3, outputPerMTok: 15 });
  assert.deepEqual(inferPricing("claude-haiku-4-5"), { inputPerMTok: 1, outputPerMTok: 5 });
  assert.deepEqual(inferPricing(undefined), { inputPerMTok: 5, outputPerMTok: 25 }); // default Opus
});

test("messageCost: applies cache multipliers (read x0.1, write5m x1.25, write1h x2)", () => {
  const pricing = { inputPerMTok: 5, outputPerMTok: 25 };
  // 1M input, 1M cacheRead, 1M write5m, 1M write1h, 1M output
  const usage = { input: 1e6, cacheRead: 1e6, cacheCreate5m: 1e6, cacheCreate1h: 1e6, output: 1e6 };
  // input 5 + read 0.5 + write5m 6.25 + write1h 10 + output 25 = 46.75
  assert.equal(messageCost(usage, pricing), 46.75);
});

test("sessionCostUsd: sums only messages with usage, prices per model", () => {
  const msgs = [
    { metadata: { model: "claude-haiku-4-5", usage: { input: 1e6, output: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0 } } }, // $1
    { metadata: { model: "claude-opus-4-8", usage: { input: 0, output: 1e6, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0 } } },   // $25
    { metadata: {} }, // no usage -> ignored
    { role: "user" },  // no metadata -> ignored
  ];
  assert.equal(sessionCostUsd(msgs), 26);
});

test("CodexAdapter sessionCwd: finds cwd in early metadata, not only line 1", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-control-"));
  const file = path.join(dir, "rollout-test.jsonl");
  const cwd = path.join(dir, "Workspace");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: "event_msg", payload: { type: "noise" } }),
      JSON.stringify({ type: "session_meta", payload: { cwd } }),
      "",
    ].join("\n"),
    "utf-8"
  );

  try {
    const adapter = new CodexAdapter();
    assert.equal(await adapter.sessionCwd(file), cwd);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HandoffGenerator: extracts Windows backslash file references", () => {
  const generator = new HandoffGenerator();
  const markdown = generator.generate(
    [
      {
        id: "1",
        role: "user",
        content: "Please review src\\extension.ts and D:\\Toolst-n\\contextbridge-vscode\\src\\watcher\\fileWatcher.ts",
        timestamp: 0,
        source: "codex",
      },
    ],
    {
      totalTokens: 100,
      modelLimit: 200000,
      percentUsed: 0.1,
      messagesCount: 1,
      estimatedRemaining: 199900,
      level: "ok",
      tokenSource: "estimate",
      estimatedCostUsd: 0,
      tokensPerMessage: 100,
      messagesUntilCritical: 1799,
    },
    "codex"
  );

  assert.match(markdown, /src\\extension\.ts/);
  assert.match(markdown, /D:\\Toolst-n\\contextbridge-vscode\\src\\watcher\\fileWatcher\.ts/);
});

test("HandoffGenerator: ignores environment and system prompt noise", () => {
  const generator = new HandoffGenerator();
  const markdown = generator.generate(
    [
      {
        id: "env",
        role: "user",
        content:
          "<environment_context><cwd>D:\\noise</cwd><filesystem>D:\\noise\\package.json</filesystem></environment_context>",
        timestamp: 0,
        source: "codex",
      },
      {
        id: "system",
        role: "system",
        content:
          "Developer instructions mention D:\\private\\secret.ts and C:/Users/user/.codex/skills/foo/SKILL.md",
        timestamp: 1,
        source: "codex",
      },
      {
        id: "ask",
        role: "user",
        content: "Please improve the dashboard and check src\\ui\\dashboard.ts",
        timestamp: 2,
        source: "codex",
      },
      {
        id: "assistant",
        role: "assistant",
        content: "Updated src\\ui\\dashboard.ts and verified the dashboard.",
        timestamp: 3,
        source: "codex",
      },
    ],
    {
      totalTokens: 100,
      modelLimit: 200000,
      percentUsed: 0.1,
      messagesCount: 4,
      estimatedRemaining: 199900,
      level: "ok",
      tokenSource: "usage",
      estimatedCostUsd: 0,
      tokensPerMessage: 25,
      messagesUntilCritical: 7196,
    },
    "codex"
  );

  assert.match(markdown, /## Goal\nPlease improve the dashboard/);
  assert.match(markdown, /src\\ui\\dashboard\.ts/);
  assert.doesNotMatch(markdown, /environment_context/);
  assert.doesNotMatch(markdown, /D:\\private\\secret\.ts/);
  assert.doesNotMatch(markdown, /package\.json/);
});

test("quotaAlert: warning latches until usage drops below warning", () => {
  const thresholds = { warning: 80, critical: 95 };
  let state = createQuotaAlertState();

  let decision = nextQuotaAlert(
    { usedPercent: 81.2, windowMinutes: 300, resetsAt: 1000 },
    state,
    thresholds
  );
  assert.equal(decision.action, "warning");
  state = decision.state;

  decision = nextQuotaAlert(
    { usedPercent: 84, windowMinutes: 300, resetsAt: 1000 },
    state,
    thresholds
  );
  assert.equal(decision.action, "none");
  state = decision.state;

  decision = nextQuotaAlert(
    { usedPercent: 79.4, windowMinutes: 300, resetsAt: 1000 },
    state,
    thresholds
  );
  assert.equal(decision.action, "none");
  state = decision.state;

  decision = nextQuotaAlert(
    { usedPercent: 80, windowMinutes: 300, resetsAt: 1000 },
    state,
    thresholds
  );
  assert.equal(decision.action, "warning");
});

test("quotaAlert: critical latches and suppresses downgrade warning", () => {
  const thresholds = { warning: 80, critical: 95 };
  let state = createQuotaAlertState();

  let decision = nextQuotaAlert(
    { usedPercent: 96, windowMinutes: 300, resetsAt: 1000 },
    state,
    thresholds
  );
  assert.equal(decision.action, "critical");
  state = decision.state;

  decision = nextQuotaAlert(
    { usedPercent: 98, windowMinutes: 300, resetsAt: 1000 },
    state,
    thresholds
  );
  assert.equal(decision.action, "none");
  state = decision.state;

  decision = nextQuotaAlert(
    { usedPercent: 90, windowMinutes: 300, resetsAt: 1000 },
    state,
    thresholds
  );
  assert.equal(decision.action, "none");
});

test("quotaAlert: quota window change starts a fresh warning cycle", () => {
  const thresholds = { warning: 80, critical: 95 };
  let state = createQuotaAlertState();

  let decision = nextQuotaAlert(
    { usedPercent: 83, windowMinutes: 300, resetsAt: 1000 },
    state,
    thresholds
  );
  assert.equal(decision.action, "warning");
  state = decision.state;

  decision = nextQuotaAlert(
    { usedPercent: 82, windowMinutes: 300, resetsAt: 2000 },
    state,
    thresholds
  );
  assert.equal(decision.action, "warning");
});

test("Notifications: quota critical suppresses duplicate context critical handoff", async () => {
  const calls = [];
  const mockVscode = {
    workspace: {
      getConfiguration() {
        return {
          get(key, fallback) {
            const values = {
              warningThreshold: 75,
              criticalThreshold: 90,
              quotaWarningThreshold: 80,
              quotaCriticalThreshold: 95,
            };
            return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;
          },
        };
      },
    },
    window: {
      showErrorMessage(message, action) {
        calls.push({ type: "error", message, action });
        return Promise.resolve(action);
      },
      showWarningMessage(message) {
        calls.push({ type: "warning", message });
        return Promise.resolve(undefined);
      },
    },
    commands: {
      executeCommand(command) {
        calls.push({ type: "command", command });
        return Promise.resolve(undefined);
      },
    },
  };
  const originalLoad = Module._load;
  const modulePath = require.resolve("../out/ui/notifications");
  delete require.cache[modulePath];
  Module._load = function load(request, parent, isMain) {
    if (request === "vscode") {
      return mockVscode;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { Notifications } = require(modulePath);
    const notifications = new Notifications();
    await notifications.react(
      {
        totalTokens: 245000,
        modelLimit: 258400,
        percentUsed: 94.8,
        messagesCount: 123,
        estimatedRemaining: 13400,
        level: "critical",
        tokenSource: "usage",
        estimatedCostUsd: 0,
        tokensPerMessage: 1992,
        messagesUntilCritical: 0,
        rateLimits: {
          planType: "plus",
          primary: { usedPercent: 96, windowMinutes: 300, resetsAt: 1000 },
        },
      },
      "sim-both-critical",
      "codex"
    );
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }

  assert.equal(calls.filter((c) => c.type === "error").length, 1);
  assert.equal(calls.filter((c) => c.type === "command").length, 1);
  assert.match(calls[0].message, /Codex session quota at 96%/);
  assert.equal(calls[1].command, "contextControl.handoff");
});


// ---------------------------------------------------------------------------
// JsonlTailReader — the incremental reader behind the fast rescan path.
// ---------------------------------------------------------------------------

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-tail-"));
  return path.join(dir, name);
}

test("JsonlTailReader: first read returns the whole file and flags fromStart", async () => {
  const f = tmpFile("a.jsonl");
  fs.writeFileSync(f, "one\ntwo\nthree\n");
  const r = new JsonlTailReader();
  const got = await r.read(f);
  assert.deepEqual(got.lines, ["one", "two", "three"]);
  assert.equal(got.fromStart, true);
});

test("JsonlTailReader: a second read of an unchanged file returns nothing", async () => {
  const f = tmpFile("b.jsonl");
  fs.writeFileSync(f, "one\ntwo\n");
  const r = new JsonlTailReader();
  await r.read(f);
  const got = await r.read(f);
  assert.deepEqual(got.lines, []);
  assert.equal(got.fromStart, false);
});

test("JsonlTailReader: only appended lines come back", async () => {
  const f = tmpFile("c.jsonl");
  fs.writeFileSync(f, "one\ntwo\n");
  const r = new JsonlTailReader();
  await r.read(f);
  fs.appendFileSync(f, "three\nfour\n");
  const got = await r.read(f);
  assert.deepEqual(got.lines, ["three", "four"]);
  assert.equal(got.fromStart, false);
});

test("JsonlTailReader: a half-written line is held until it is complete", async () => {
  const f = tmpFile("d.jsonl");
  fs.writeFileSync(f, "one\n");
  const r = new JsonlTailReader();
  await r.read(f);

  fs.appendFileSync(f, "par"); // writer caught mid-line
  assert.deepEqual((await r.read(f)).lines, []);

  fs.appendFileSync(f, "tial\n");
  assert.deepEqual((await r.read(f)).lines, ["partial"]);
});

test("JsonlTailReader: a multi-byte character split across reads survives", async () => {
  const f = tmpFile("e.jsonl");
  fs.writeFileSync(f, "one\n");
  const r = new JsonlTailReader();
  await r.read(f);

  // "สวัสดี" is 3 bytes per character in UTF-8; cut one character in half.
  const text = Buffer.from('{"t":"สวัสดี"}\n', "utf-8");
  const cut = 10; // lands inside a multi-byte sequence
  fs.appendFileSync(f, text.subarray(0, cut));
  assert.deepEqual((await r.read(f)).lines, []);
  fs.appendFileSync(f, text.subarray(cut));
  assert.deepEqual((await r.read(f)).lines, ['{"t":"สวัสดี"}']);
});

test("JsonlTailReader: a truncated (rotated) file is re-read from the start", async () => {
  const f = tmpFile("f.jsonl");
  fs.writeFileSync(f, "one\ntwo\nthree\n");
  const r = new JsonlTailReader();
  await r.read(f);

  fs.writeFileSync(f, "fresh\n"); // shorter than before
  const got = await r.read(f);
  assert.equal(got.fromStart, true);
  assert.deepEqual(got.lines, ["fresh"]);
});

test("JsonlTailReader: forget() drops the cursor so the next read starts over", async () => {
  const f = tmpFile("g.jsonl");
  fs.writeFileSync(f, "one\ntwo\n");
  const r = new JsonlTailReader();
  await r.read(f);
  r.forget(f);
  const got = await r.read(f);
  assert.equal(got.fromStart, true);
  assert.deepEqual(got.lines, ["one", "two"]);
});

// ---------------------------------------------------------------------------
// ClaudeCodeAdapter — incremental parse must equal a full parse.
// ---------------------------------------------------------------------------

function claudeLine(i, tokens) {
  return JSON.stringify({
    type: i % 2 === 0 ? "user" : "assistant",
    uuid: "u" + i,
    timestamp: new Date(1700000000000 + i * 1000).toISOString(),
    message: {
      role: i % 2 === 0 ? "user" : "assistant",
      model: "claude-opus-4-5",
      content: [{ type: "text", text: "message " + i }],
      usage: i % 2 === 0 ? undefined : { input_tokens: tokens, output_tokens: 10 },
    },
  });
}

test("ClaudeCodeAdapter: incremental parse matches a single full parse", async () => {
  const f = tmpFile("session.jsonl");
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push(claudeLine(i, 1000 + i * 10));

  fs.writeFileSync(f, lines.join("\n") + "\n");
  const full = await new ClaudeCodeAdapter().parse(f);

  // same content, delivered in three appends
  const f2 = tmpFile("session2.jsonl");
  fs.writeFileSync(f2, lines.slice(0, 12).join("\n") + "\n");
  const a = new ClaudeCodeAdapter();
  await a.parse(f2);
  fs.appendFileSync(f2, lines.slice(12, 30).join("\n") + "\n");
  await a.parse(f2);
  fs.appendFileSync(f2, lines.slice(30).join("\n") + "\n");
  const incremental = await a.parse(f2);

  assert.equal(incremental.length, full.length);
  assert.equal(incremental.length, 40);
  assert.deepEqual(
    incremental.map((m) => m.content),
    full.map((m) => m.content)
  );
  assert.deepEqual(
    incremental.map((m) => m.metadata && m.metadata.contextTokens),
    full.map((m) => m.metadata && m.metadata.contextTokens)
  );
});

test("ClaudeCodeAdapter: filesReferenced follows the newest message", async () => {
  const f = tmpFile("files.jsonl");
  const snapshot = JSON.stringify({
    type: "file-history-snapshot",
    snapshot: { trackedFileBackups: { "a.ts": 1, "b.ts": 1 } },
  });
  fs.writeFileSync(f, [claudeLine(0, 100), snapshot, claudeLine(1, 200)].join("\n") + "\n");

  const a = new ClaudeCodeAdapter();
  let msgs = await a.parse(f);
  assert.deepEqual(msgs[msgs.length - 1].metadata.filesReferenced.sort(), ["a.ts", "b.ts"]);
  const previousLast = msgs[msgs.length - 1];

  fs.appendFileSync(f, claudeLine(2, 300) + "\n");
  msgs = await a.parse(f);
  assert.equal(msgs.length, 3);
  // the list moved to the new last message and did not linger on the old one
  assert.deepEqual(msgs[2].metadata.filesReferenced.sort(), ["a.ts", "b.ts"]);
  assert.equal(previousLast.metadata.filesReferenced, undefined);
});

test("ClaudeCodeAdapter: sidechain turns are skipped incrementally too", async () => {
  const f = tmpFile("side.jsonl");
  fs.writeFileSync(f, claudeLine(0, 100) + "\n");
  const a = new ClaudeCodeAdapter();
  await a.parse(f);

  const side = JSON.stringify({
    type: "assistant",
    uuid: "s1",
    isSidechain: true,
    message: { role: "assistant", content: [{ type: "text", text: "subagent" }] },
  });
  fs.appendFileSync(f, side + "\n" + claudeLine(1, 500) + "\n");
  const msgs = await a.parse(f);
  assert.equal(msgs.length, 2);
  assert.ok(!msgs.some((m) => m.content === "subagent"));
});

test("ClaudeCodeAdapter: malformed lines are skipped, not fatal", async () => {
  const f = tmpFile("bad.jsonl");
  fs.writeFileSync(f, claudeLine(0, 100) + "\n{not json\n" + claudeLine(1, 200) + "\n");
  const msgs = await new ClaudeCodeAdapter().parse(f);
  assert.equal(msgs.length, 2);
});
