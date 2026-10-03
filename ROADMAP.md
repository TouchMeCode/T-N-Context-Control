# T&N Context Control — Product Roadmap

Last updated: 2026-10-04

## Product direction

Context Control should become the local control center for AI-assisted work,
not a monitor tied to one provider or one editor. A user should be able to move
between AI models, coding agents, and compatible IDEs without losing context,
quota visibility, project state, or a usable handoff.

Everything remains local-first: conversation content and source code stay on
the user's machine unless the user explicitly chooses to export or share them.

## Provider expansion

Planned research order:

1. **Gemini** — inspect real Gemini CLI / coding-agent session storage, model
   metadata, context usage, and any locally recorded quota information.
2. **Cursor** — support Cursor-native conversations in addition to running the
   existing Claude Code or Codex adapters inside Cursor.
3. **Antigravity and other AI-first IDEs** — verify their actual product name,
   storage location, schema, and extension compatibility before implementation.
4. **Additional tools** — evaluate GitHub Copilot Chat, Continue, Windsurf-native
   conversations, and other widely used local AI coding agents.

An adapter must not be enabled by default until it has been verified against
real data. Missing provider fields must be shown as unavailable, never replaced
with plausible-looking invented values.

## Editor and distribution expansion

- Keep VS Code as the reference host.
- Test the packaged extension in Cursor and Windsurf on every release.
- Research Antigravity and other VS Code-compatible editors individually.
- Publish through the appropriate extension registries where possible, while
  retaining a small standalone VSIX for manual installation.
- Keep commands, settings, webviews, accessibility, and local privacy behavior
  consistent across supported hosts.

## Cross-provider architecture

Each adapter should report capabilities explicitly:

- conversation messages and roles;
- active model and ordered model-switch history;
- current context tokens and context-window size;
- provider quota/rate-limit windows and reset times, when genuinely reported;
- project/workspace association;
- edited or referenced files;
- token/cost breakdown when reliable.

The UI must continue to separate **context usage** from **provider quota**.
Sessions remain the primary unit even when the user switches models. Context
uses the latest provider-reported state, while cost is accumulated per message
using the model active for that message.

## Handoff direction

- Preserve a compact representation of every meaningful conversation turn.
- Carry initial and latest user intent, decisions, pending work, referenced
  files, active model, and model history.
- Produce a provider-neutral continuation prompt that another AI can use
  without requiring the user to explain the project again.
- Improve local summarization without sending private conversations to a remote
  service by default.

## Quality gates for a new provider or editor

Before calling support stable:

1. Capture representative real sessions, including long sessions, model
   switches, tool calls, malformed/torn writes, and provider limit events.
2. Document the observed schema and which fields are authoritative.
3. Add fixtures and regression tests for incremental parsing and metadata.
4. Measure activation, refresh, dashboard cold/warm performance, and memory.
5. Verify context and quota labels cannot be confused.
6. Verify generated handoffs allow a fresh AI session to continue the work.
7. Test light/dark themes, keyboard access, and color-independent status text.
8. Package and smoke-test the production VSIX in each claimed editor.

