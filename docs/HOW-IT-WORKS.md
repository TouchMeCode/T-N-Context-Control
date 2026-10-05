# T&N Context Control ทำงานอย่างไร

เอกสารนี้อธิบายภาพรวมของ extension, วิธีที่เครื่องมือทำงานกับข้อมูล local ของ AI coding tools, และโครงสร้างโค้ดหลักในโปรเจกต์ `tn-context-control`.

เวอร์ชันที่อธิบายในเอกสารนี้: `0.1.1`

## สรุปสั้น

T&N Context Control คือ VS Code extension ที่อ่านประวัติ conversation ของ AI coding assistant จากเครื่องผู้ใช้ เช่น Claude Code, Codex CLI และ Cline แล้วคำนวณว่า session ปัจจุบันใช้ context window ไปเท่าไร

เครื่องมือทำ 4 เรื่องหลัก:

1. อ่านไฟล์ conversation ที่อยู่ใน local storage ของแต่ละ AI tool
2. แปลงข้อมูลแต่ละ provider ให้อยู่ใน format กลางเดียวกัน
3. วิเคราะห์ token usage, context limit, warning/critical level และ cost estimate
4. แสดงผลใน status bar, dashboard และสร้าง handoff markdown เพื่อเอาไปต่อใน AI session ใหม่

จุดสำคัญด้าน privacy: extension อ่านไฟล์ในเครื่องเท่านั้น ไม่ส่ง conversation ออก network และไม่ต้องใช้ API key ของ AI provider

## Use Case หลัก

ปัญหาที่เครื่องมือนี้แก้คือเวลาใช้ AI coding assistant นาน ๆ context window จะเต็มโดยผู้ใช้ไม่รู้ตัว พอ context ใกล้เต็ม AI จะเริ่มลืมบริบทเก่า ตอบเพี้ยน หรือทำงานต่อยาก

T&N Context Control ช่วยให้ผู้ใช้เห็นล่วงหน้าว่า:

- ใช้ context ไปแล้วกี่ token
- ใช้ไปกี่เปอร์เซ็นต์ของ model limit
- เหลืออีกประมาณกี่ message ก่อนถึง critical threshold
- session ไหนในเครื่องใช้ context หนักสุด
- ควร generate handoff เมื่อไร

แนวคิด handoff คือสร้างไฟล์ `.md` ที่สรุป goal, progress, decision, TODO, referenced files และ next prompt เพื่อให้ผู้ใช้เปิด AI session ใหม่แล้ว paste ต่อได้ทันที

## ข้อมูลไหลอย่างไร

Flow หลักเมื่อ extension ทำงาน:

```text
VS Code activates extension
        |
        v
Load enabled adapters from settings
        |
        v
Watch local storage folders
        |
        v
Scan newest matching session
        |
        v
Parse provider-specific files into NormalizedMessage[]
        |
        v
Infer model context limit
        |
        v
Analyze token usage and severity level
        |
        v
Update status bar + notifications
        |
        v
Dashboard / Handoff commands can reuse the parsed session data
```

ไฟล์ entry point คือ `src/extension.ts`

## โครงสร้างโปรเจกต์

```text
src/
  extension.ts              VS Code activation, command registration, scan flow
  adapters/
    base.ts                 interface/base class ของ adapter
    claudeCode.ts           อ่าน Claude Code JSONL
    codex.ts                อ่าน Codex CLI rollout JSONL
    cline.ts                อ่าน Cline แบบ best-effort จาก public docs
  core/
    types.ts                type กลางของระบบ
    analyzer.ts             คำนวณ context stats
    tokenizer.ts            fallback token counting ด้วย tiktoken
    modelLimits.ts          infer context window จาก model id
    pricing.ts              cost estimation สำหรับ Claude
  watcher/
    fileWatcher.ts          watch local conversation files
  ui/
    statusBar.ts            status bar item
    notifications.ts        warning / critical notifications
    dashboard.ts            webview dashboard
  handoff/
    ruleBased.ts            rule-based handoff generator
    template.ts             markdown template
  exporters/
    markdown.ts             เขียน handoff markdown ลง workspace

test/
  pure.test.js              unit tests สำหรับ logic ที่ไม่ต้องพึ่ง VS Code host

dist/
  extension.js              production bundle จาก esbuild

out/
  *.js                      output จาก TypeScript compile
```

## VS Code Activation

ใน `package.json` extension ตั้งค่า:

```json
"activationEvents": ["onStartupFinished"],
"main": "./dist/extension.js"
```

หมายความว่าเมื่อ VS Code startup เสร็จ extension จะ activate และโหลดไฟล์ bundle `dist/extension.js`

ระหว่าง development สามารถใช้ `npm run compile` เพื่อ build ไปที่ `out/` หรือ `npm run bundle` เพื่อสร้าง production bundle ไปที่ `dist/extension.js`

## Settings ที่ผู้ใช้ปรับได้

ใน `package.json` มี configuration:

```json
"contextControl.warningThreshold": 75,
"contextControl.criticalThreshold": 90,
"contextControl.outputDir": ".ai-memory",
"contextControl.adapters": ["claude-code", "cline", "codex"]
```

ความหมาย:

- `warningThreshold`: เปอร์เซ็นต์ที่เริ่มเตือน เช่น 75%
- `criticalThreshold`: เปอร์เซ็นต์ที่ถือว่าใกล้เต็มมาก เช่น 90%
- `outputDir`: โฟลเดอร์ที่จะเก็บ handoff markdown
- `adapters`: เปิด/ปิด provider ที่ต้องการให้ scan

## Type กลางของระบบ

ไฟล์ `src/core/types.ts` นิยาม type สำคัญคือ `NormalizedMessage`

```ts
export interface NormalizedMessage {
  id: string;
  role: Role;
  content: string;
  timestamp: number;
  source: Source;
  metadata?: {
    model?: string;
    filesReferenced?: string[];
    contextTokens?: number;
    contextWindow?: number;
    usage?: UsageBreakdown;
  };
}
```

ทุก adapter ไม่ว่าจะอ่านจาก Claude Code, Codex หรือ Cline ต้องแปลงข้อมูล provider-specific ให้กลายเป็น `NormalizedMessage[]`

เหตุผลที่ต้องมี type กลาง:

- analyzer ไม่ต้องรู้ว่า source มาจาก provider ไหน
- dashboard แสดงข้อมูลทุก provider ด้วย format เดียวกัน
- handoff generator ใช้ message list เดียวกัน
- token/cost/model limit logic แยกจาก parsing logic ได้ชัดเจน

## Adapter Pattern

ทุก provider adapter extends `BaseAdapter` ใน `src/adapters/base.ts`

```ts
export abstract class BaseAdapter implements IAdapter {
  abstract name: Source;
  abstract getStoragePath(): string;
  abstract parse(filePath: string): Promise<NormalizedMessage[]>;
  abstract listSessions(workspacePath?: string): Promise<string[]>;
}
```

adapter ต้องทำ 3 อย่าง:

1. บอกว่า storage path ของ provider อยู่ที่ไหน
2. list session files เรียงจากใหม่ไปเก่า
3. parse session file แล้วคืน `NormalizedMessage[]`

## Claude Code Adapter

ไฟล์: `src/adapters/claudeCode.ts`

Claude Code เก็บ conversation เป็น JSONL ที่:

```text
~/.claude/projects/<project-id>/<session-uuid>.jsonl
```

บน Windows ตัวอย่าง project id จะมาจาก workspace path ที่ encode แล้ว เช่น:

```text
D:\Projects\sample-app -> d--Projects-sample-app
C:\Work\demo-api -> c--Work-demo-api
```

### listSessions

ถ้ามี workspace เปิดอยู่ adapter จะพยายามหา project folder ที่ match workspace ก่อน เพื่อไม่ไปหยิบ session จาก project อื่น

ถ้าไม่เจอ session ของ workspace ปัจจุบัน จะ fallback ไป scan global sessions ทั้งหมด แล้วเรียงตาม `mtime`

### parse

Claude Code file เป็น JSONL หนึ่ง record ต่อหนึ่งบรรทัด

adapter จะ:

- อ่านทีละบรรทัดด้วย stream/readline
- skip blank line
- skip malformed JSON line
- เก็บเฉพาะ record type `user` และ `assistant`
- skip `isSidechain === true` เพราะเป็น sub-agent turn ที่ไม่ควรนับรวม context หลัก
- flatten content block เช่น `text`, `thinking`, `tool_use`, `tool_result`, `image`
- ดึง token usage จาก `message.usage`
- ดึง edited files จาก `file-history-snapshot`

### Claude contextTokens

สำหรับ Claude Code จะคำนวณ context occupancy จาก:

```text
input_tokens
+ cache_read_input_tokens
+ cache_creation_input_tokens
+ output_tokens
```

เหตุผลที่รวม `output_tokens`: หลัง assistant ตอบแล้ว ข้อความ assistant output จะกลายเป็นส่วนหนึ่งของ conversation context สำหรับ turn ถัดไป ดังนั้นถ้าต้องการวัด context occupancy ณ จุดนั้น output ล่าสุดควรถูกนับรวมด้วย

### Claude cost

adapter ยังสร้าง `metadata.usage` เพื่อให้ `pricing.ts` ประเมิน cost ได้

ใช้ breakdown:

- input
- output
- cacheRead
- cacheCreate5m
- cacheCreate1h

## Codex Adapter

ไฟล์: `src/adapters/codex.ts`

Codex CLI เก็บ session ที่:

```text
~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl
```

ตัวอย่าง:

```text
~/.codex/sessions/2026/06/18/rollout-2026-06-18T00-00-00-uuid.jsonl
```

### listSessions

adapter จะ recursively walk root folder แล้วเก็บไฟล์ `.jsonl` จาก date-partitioned tree

ถ้ามี workspace path ส่งเข้ามา จะพยายามอ่าน `cwd` จาก early session metadata แล้วเทียบกับ workspace ปัจจุบัน

การเทียบ path:

- บน Windows จะ lower-case ก่อนเทียบ เพราะ filesystem case-insensitive
- บน POSIX จะคง case เดิม เพราะ path อาจ case-sensitive

### parse

Codex session เป็น JSONL ที่แต่ละ line มีรูปแบบประมาณ:

```json
{ "timestamp": "...", "type": "...", "payload": { ... } }
```

adapter สนใจ record หลัก:

- `turn_context`: ดึง model id
- `event_msg` + `payload.type === "token_count"`: ดึง token usage และ context window
- `response_item`: ดึง message/tool call/tool output

Codex token source ที่สำคัญ:

```text
payload.info.last_token_usage.input_tokens
payload.info.model_context_window
```

โดย `input_tokens` ของ Codex คือ current prompt size ซึ่งเหมาะใช้แทน current context occupancy

### Codex cost

ตอนนี้ Codex ไม่ใส่ `metadata.usage` เพราะยังไม่มี pricing table สำหรับ GPT/Codex ใน extension นี้ ดังนั้น dashboard cost ของ Codex จะเป็น `$0.00` โดยตั้งใจ ไม่ใช่ bug

## Cline Adapter

ไฟล์: `src/adapters/cline.ts`

สถานะ: implemented แบบ best-effort จาก public docs แต่ยังไม่ได้ verify กับ real Cline data

path ที่คาดไว้:

```text
<editor>/User/globalStorage/saoudrizwan.claude-dev/tasks/<task-id>/
  api_conversation_history.json
  ui_messages.json
```

adapter probe หลาย editor:

- VS Code
- Cursor
- Windsurf
- Windsurf - Next
- Code - Insiders

ข้อควรระวัง:

- field names เช่น `api_req_started`, `tokensIn`, `tokensOut`, `cacheReads`, `cacheWrites` ยังเป็น TODO
- ถ้า Cline เปลี่ยน schema อาจต้องปรับ parser
- parser ถูกเขียนให้ fail gracefully คือ parse ไม่ได้ก็ return empty หรือ skip

## File Watcher

ไฟล์: `src/watcher/fileWatcher.ts`

extension watch storage path ของทุก enabled adapter ด้วย `chokidar`

```ts
chokidar.watch(existing, {
  ignoreInitial: false,
  depth: 4,
  awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
});
```

เหตุผลของ `depth: 4`:

- Claude Code ลึกประมาณ `projects/<project-id>/<file>.jsonl`
- Codex ลึกกว่า คือ `sessions/YYYY/MM/DD/rollout-*.jsonl`
- ถ้า depth น้อยเกินไป live update ของ Codex จะไม่ยิง

watcher สนใจเฉพาะไฟล์ `.jsonl` และ `.json`

เมื่อมี add/change จะ debounce 500ms ก่อนเรียก `scan(true)` เพื่อลดการ analyze ซ้ำถี่ ๆ ขณะ provider กำลังเขียนไฟล์

## Scan Flow

ฟังก์ชันหลักอยู่ใน `src/extension.ts`

```ts
async function scan(silent = false): Promise<void>
```

ขั้นตอน:

1. อ่าน workspace path ปัจจุบันจาก `vscode.workspace.workspaceFolders`
2. วนทุก enabled adapter
3. เรียก `adapter.listSessions(workspacePath)`
4. เลือก session ใหม่สุดของ adapter นั้น
5. parse session เป็น `NormalizedMessage[]`
6. เทียบ `mtime` ระหว่าง adapter เพื่อเลือก session ล่าสุดจริง
7. infer model limit
8. analyze messages
9. update status bar
10. trigger notifications
11. เก็บ `latest` ไว้ให้ command อื่นใช้

จุดสำคัญคือหลัง bugfix เวอร์ชัน `0.1.1` จะไม่เลือก adapter แรกแบบ blind อีกแล้ว แต่เลือก session ที่ใหม่สุดจริงจาก `mtime`

## Model Limit Inference

ไฟล์: `src/core/modelLimits.ts`

ระบบหา context window ตามลำดับนี้:

1. ถ้า provider รายงาน `metadata.contextWindow` ให้ใช้ค่านั้นก่อน เช่น Codex `model_context_window`
2. ถ้าไม่มี explicit window ให้ infer จาก model id
3. ถ้าไม่รู้จัก model ให้ fallback เป็น `200_000`

กติกา Claude model:

- model id ที่มี `1m` หรือ `[1m]` -> `1_000_000`
- Opus/Sonnet 4.5 ขึ้นไป -> `1_000_000`
- Haiku และรุ่นเก่ากว่า -> `200_000`
- unknown -> `200_000`

## Analyzer

ไฟล์: `src/core/analyzer.ts`

`Analyzer.analyze(messages, modelLimit)` คืน `ContextStats`

ขั้นตอนคิด token:

1. ถ้ามี `metadata.contextTokens` จาก provider ให้ใช้ real usage
2. ถ้ามีหลาย message ที่มี real usage ให้ใช้ค่าสูงสุด เพราะ context usage สะสมตามเวลา
3. ถ้าไม่มี real usage ให้ fallback ไป `countMessages(messages)` ด้วย tokenizer estimate

หลังได้ total tokens แล้ว analyzer จะ:

- sanitize model limit ไม่ให้ report เกิน 100% แบบผิด ๆ
- คิด percent used
- คิด estimated remaining
- คิด tokens per message
- คิด messages until critical
- คิด level: `ok`, `warning`, `critical`
- คิด estimated cost

### sanitizeLimit

ถ้า observed usage มากกว่า inferred limit แปลว่า limit ที่ infer มาอาจเล็กเกินไป ระบบจะ bump limit เป็น tier ที่สมเหตุผล เช่น 1M หรือ observed usage เพื่อไม่แสดงผลแบบเกิน 100% ที่ทำให้ user เข้าใจผิด

### messagesUntilCritical

ใช้สูตร:

```text
criticalTokens = criticalThreshold% * modelLimit
remaining = criticalTokens - totalTokens
messagesUntilCritical = floor(remaining / tokensPerMessage)
```

ถ้า tokens/message เป็น 0 จะคืน `Infinity`

## Tokenizer Fallback

ไฟล์: `src/core/tokenizer.ts`

ถ้า provider ไม่มี real token usage extension จะใช้ `tiktoken` encoding `cl100k_base`

ถ้าโหลด `tiktoken` ไม่ได้ จะ fallback เป็น heuristic:

```text
ceil(text.length / 4)
```

ข้อควรเข้าใจ:

- `tiktoken` แม่นกับ OpenAI-style tokenizer มากกว่า
- สำหรับ Claude/Gemini เป็น estimate เท่านั้น
- extension จะ prefer provider usage ก่อนเสมอถ้ามี

## Pricing

ไฟล์: `src/core/pricing.ts`

ตอนนี้คิด cost เฉพาะ Claude เพราะมี pricing table ในโค้ด

ราคาโดยประมาณต่อ 1M token:

| Model family | Input | Output |
|---|---:|---:|
| Opus | $5 | $25 |
| Sonnet | $3 | $15 |
| Haiku | $1 | $5 |

cache multipliers:

| Type | Multiplier |
|---|---:|
| cache read | 0.1x input price |
| cache write 5m | 1.25x input price |
| cache write 1h | 2.0x input price |

ถ้า message ไม่มี `metadata.usage` จะไม่คิด cost

ผลคือ Codex/Cline อาจแสดง `$0.00` ถ้าไม่มี usage breakdown ที่ตรง schema

## Status Bar

ไฟล์: `src/ui/statusBar.ts`

status bar แสดงประมาณ:

```text
$(pulse) CC: 45% 116k/258k
```

ข้อมูลที่ใช้มาจาก `ContextStats`

ปกติผู้ใช้ดูได้ทันทีว่า:

- ใช้ไปกี่ %
- ใช้ไปกี่ token
- model limit เท่าไร
- hover เพื่อดูรายละเอียด เช่น tokens/message, messages until critical, cost

สีของ status bar เปลี่ยนตาม level:

- `ok`
- `warning`
- `critical`

## Notifications

ไฟล์: `src/ui/notifications.ts`

ระบบ notification มี latch เพื่อไม่ spam ผู้ใช้

พฤติกรรม:

- warning แสดงครั้งเดียวต่อ session
- critical แสดง error message และเสนอปุ่ม `Generate Handoff`
- latch ถูก reset เมื่อเปลี่ยน session file
- critical latch reset เมื่อ usage กลับต่ำกว่า critical

หลัง bugfix `0.1.1` notification ใช้ `sessionKey` เป็น file path เพื่อแยกสถานะระหว่าง session เก่าและ session ใหม่

## Dashboard

ไฟล์: `src/ui/dashboard.ts`

Dashboard เป็น VS Code webview ที่ list session ทุก adapter

ข้อมูลต่อ row:

- project
- source
- message count
- total tokens / model limit
- usage %
- estimated cost
- action button `Handoff`

Flow:

```text
Command: Context Control: Open Dashboard
        |
        v
Dashboard.show()
        |
        v
collectSummaries()
        |
        v
adapter.listSessions()
        |
        v
sort candidates by mtime
        |
        v
parse latest 50 sessions total
        |
        v
postMessage to webview
```

เหตุผลที่ limit 50 sessions:

- session file บางไฟล์อาจใหญ่หลายสิบ MB
- parse ทีละไฟล์บน extension host อาจทำให้ UI หน่วง
- จึง parse เฉพาะ 50 session ล่าสุดรวมทุก adapter

Dashboard มีปุ่ม refresh และ header sort ใน webview

## Handoff Generator

ไฟล์: `src/handoff/ruleBased.ts`

handoff generator ไม่ใช้ LLM และไม่ส่งข้อมูลออกจากเครื่อง เป็น rule-based ทั้งหมด

output จะถูก render ด้วย template ใน `src/handoff/template.ts`

section หลัก:

- Goal
- Current Progress
- Important Decisions
- Pending Tasks
- Files Referenced
- Recommended Next Prompt

### Goal

ใช้ user message แรกที่มีเนื้อหา แล้ว clean/truncate ไม่เกิน 200 characters

### Progress

สรุปจาก stats เช่น message count, token count, percent, token source

### Decisions

ค้นหาประโยคที่มี keyword เช่น:

- decided
- chose
- will use
- going with
- ตัดสินใจ
- เลือกใช้
- เลือก

จำกัดจำนวนเพื่อไม่ให้ handoff ยาวเกินไป

### Pending Tasks

หา whole-line TODO/FIXME:

```text
TODO: ...
FIXME: ...
```

### Files Referenced

ถ้า Claude Code มี `metadata.filesReferenced` จาก `file-history-snapshot` จะใช้ข้อมูลนั้นก่อน เพราะแม่นกว่า regex

ถ้าไม่มี จะ regex หา path ที่หน้าตาเหมือนไฟล์และ extension อยู่ใน allowlist เช่น:

- `.ts`
- `.tsx`
- `.js`
- `.json`
- `.md`
- `.py`
- `.yml`
- `.css`
- `.html`

หลัง bugfix `0.1.1` regex รองรับ Windows backslash path เช่น:

```text
src\extension.ts
D:\Projects\context-control\src\watcher\fileWatcher.ts
```

### Recommended Next Prompt

ใช้ assistant message ล่าสุดที่มีเนื้อหา แล้ว truncate ไม่เกิน 400 characters

## Markdown Exporter

ไฟล์: `src/exporters/markdown.ts`

เมื่อ generate handoff ระบบจะเขียน markdown ลง folder ที่ตั้งค่าไว้ใน `contextControl.outputDir`

default:

```text
.ai-memory/
```

ไฟล์นี้ออกแบบให้ผู้ใช้ copy/paste ไปเปิด AI session ใหม่ได้

## Commands

ประกาศใน `package.json`:

| Command ID | Title | ทำอะไร |
|---|---|---|
| `contextControl.scan` | Context Control: Scan Conversations | scan local session ล่าสุด |
| `contextControl.status` | Context Control: Show Context Status | แสดง summary popup |
| `contextControl.handoff` | Context Control: Generate Handoff | generate handoff จาก session ล่าสุด |
| `contextControl.export` | Context Control: Export Handoff to .md | alias ของ handoff |
| `contextControl.dashboard` | Context Control: Open Dashboard | เปิด dashboard webview |

## Build, Test, Package

คำสั่งหลัก:

```bash
npm install
npm run compile
npm test
npm run bundle
npx @vscode/vsce package
```

ความหมาย:

- `npm run compile`: TypeScript compile ไปที่ `out/`
- `npm test`: compile แล้วรัน Node test ใน `test/pure.test.js`
- `npm run bundle`: esbuild bundle production ไปที่ `dist/extension.js`
- `npx @vscode/vsce package`: สร้าง `.vsix`

ไฟล์ `.vscodeignore` exclude source/test/docs/out และ include เฉพาะของที่ runtime ต้องใช้ เช่น:

- `dist/extension.js`
- `package.json`
- `README.md`
- `LICENSE`
- `icon.png`
- `node_modules` dependencies ที่จำเป็น

`tiktoken` และ `chokidar` ถูกตั้งเป็น esbuild external เพื่อให้ runtime โหลดจาก `node_modules` ได้ โดยเฉพาะ `tiktoken` ที่มี WASM asset

## Unit Tests

ไฟล์: `test/pure.test.js`

ทดสอบ logic ที่ไม่ต้องพึ่ง VS Code extension host เช่น:

- infer model limit
- explicit context window priority
- pricing calculation
- cache multipliers
- session cost
- Codex `sessionCwd` อ่าน metadata ช่วงต้นไฟล์
- handoff generator จับ Windows backslash file path

ปัจจุบัน `npm test` ผ่าน 11 tests

## Error Handling และ Robustness

extension ออกแบบให้ scan ไม่ crash ง่าย:

- JSONL malformed line -> skip
- unreadable file -> ignore
- missing storage folder -> return empty list
- adapter parse fail -> log warning แล้วไป adapter ถัดไป
- tiktoken load fail -> fallback เป็น char/4 estimate
- Codex session metadata partial/missing -> fallback global sessions
- dashboard summarize fail บาง file -> skip file นั้น

แนวคิดคือ local AI tools อาจเขียนไฟล์ค้างครึ่งบรรทัดหรือ schema เปลี่ยนได้ extension จึงต้อง tolerate partial data

## Privacy Model

T&N Context Control ทำงาน local-first:

- อ่านไฟล์ conversation จาก disk
- วิเคราะห์ใน extension host
- generate dashboard/webview local
- generate markdown local
- ไม่เรียก AI API
- ไม่ส่ง conversation ไป server

กรณีมี network จะเกี่ยวกับ build/publish tooling เท่านั้น เช่น `npx @vscode/vsce package/publish` ไม่ใช่ runtime ของ extension

## ข้อจำกัดปัจจุบัน

1. Cline adapter ยังไม่ verified กับ real data
2. GPT/Codex cost ยังไม่ประเมิน เพราะไม่มี pricing table ในโค้ด
3. Dashboard parse 50 session ล่าสุดเท่านั้น ไม่ใช่ทุก session ในเครื่อง
4. Handoff เป็น rule-based ไม่ใช่ LLM summary จึงอาจ miss decision/TODO บางรูปแบบ
5. tiktoken fallback ไม่แม่น 100% สำหรับ non-OpenAI tokenizer
6. Model limit inference อาจต้อง update ตาม model รุ่นใหม่ในอนาคต

## สิ่งที่เปลี่ยนใน 0.1.1

เวอร์ชัน `0.1.1` เป็น bugfix release หลัก ๆ:

- แก้ file watcher ให้ครอบ Codex path ที่ลึก `sessions/YYYY/MM/DD`
- แก้ scan ให้เลือก session ล่าสุดจริงจาก `mtime` ไม่ใช่ adapter แรกที่เจอ
- จำกัด dashboard parse เป็น 50 session ล่าสุดรวมทุก adapter
- reset notification latch ต่อ session file
- ปรับ Codex workspace path compare ให้ถูกบน Windows/POSIX
- ปรับ Codex metadata probe ไม่ให้พึ่ง line แรกเท่านั้น
- escape quote ใน dashboard webview attributes
- handoff regex รองรับ Windows backslash path
- เพิ่ม regression tests สำหรับ Codex metadata และ Windows paths

## Mental Model สำหรับคนอ่านโค้ด

ถ้าจะอ่านโค้ดให้เข้าใจเร็ว แนะนำลำดับนี้:

1. อ่าน `src/core/types.ts` เพื่อเข้าใจ data model กลาง
2. อ่าน `src/adapters/base.ts` เพื่อเข้าใจ adapter contract
3. อ่าน `src/extension.ts` เพื่อเห็น activation/scan/command flow
4. อ่าน `src/adapters/claudeCode.ts` และ `src/adapters/codex.ts` เพื่อเข้าใจ parsing
5. อ่าน `src/core/analyzer.ts` และ `src/core/modelLimits.ts` เพื่อเข้าใจ token usage
6. อ่าน `src/ui/statusBar.ts`, `notifications.ts`, `dashboard.ts` เพื่อเข้าใจ UI
7. อ่าน `src/handoff/ruleBased.ts` เพื่อเข้าใจ handoff generation
8. อ่าน `test/pure.test.js` เพื่อเห็น expected behavior ที่สำคัญ

สั้นที่สุด: adapter แปลงข้อมูลเป็น `NormalizedMessage[]`; analyzer แปลง messages เป็น `ContextStats`; UI และ handoff ใช้ `ContextStats` กับ messages เพื่อแสดงผลหรือ export ต่อ
