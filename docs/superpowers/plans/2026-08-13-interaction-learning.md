# Interaction Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record workspace-local submitted prompts, structured pending-input requests, and short-window cancelled-draft corrections without affecting project preference learning.

**Architecture:** The standalone plugin owns strict interaction records, local JSONL persistence, pairing, reporting, querying, deletion, and all privacy boundaries. Kilo exposes one validated, best-effort `prompt.draft.cancelled` plugin-stream event and each interactive client reports an Escape-cleared non-empty draft through the backend; existing question and permission events are forwarded unchanged. The plugin consumes those events alongside `chat.message`, keeping cancelled-draft state in memory per session and persisting content only in the active workspace.

**Tech Stack:** TypeScript, Bun, Zod, `@opencode-ai/plugin`, Effect/EventV2, SolidJS, OpenTUI, VS Code webview messaging, Bun tests.

## Global Constraints

- Keep plugin source, versioning, npm publishing, and runtime dependencies independent from the Kilo monorepo; retain only `@opencode-ai/plugin` as peer dependency `>=1.18.16 <2`.
- Preserve `.kilo/project-profile.json` and `.kilo/project-profile-events.jsonl`; write interaction content only to `.kilo/project-profile-interactions.jsonl`.
- Persist raw text only locally in the active workspace, never in telemetry, preference events, context injection, or `project_profile_status` output by default.
- Retain no more than 1,000 interaction records and no records older than 90 days; compact on every append and skip malformed retained rows individually.
- Pair only the latest `prompt.draft.cancelled` with the first subsequent `chat.message` for the same `sessionID` when its timestamp is within 10,000 ms; clear the pending pairing state after that first submission whether or not it matched.
- Do not label draft data as voice input. Reports may say "possible voice-input correction" only for a recorded cancellation-and-replacement pair.
- Record pending user input only from structured `question.*` and `permission.*` lifecycle events, never from assistant prose.
- Interaction capture, parsing, storage, retention, matching, querying, and reporting must fail open and never block host input clearing, message sending, request handling, preference learning, or context injection.
- Kilo changes in shared `packages/opencode/src/**` must be minimized and bracketed with `kilocode_change` markers; put Kilo-only helpers/tests under paths containing `kilocode` where practical.
- Implement and verify from isolated worktrees. Merge validated branches into each repository's `main`; publish only the standalone package from its updated `main` and matching `v*` tag.

---

## File Structure

### Standalone repository: `/Users/liangchao/Downloads/opencode-project-profile-interactions`

- Create: `src/interactions.ts` - strict interaction schema, JSONL path/load/append/retention, record selection, and deletion.
- Create: `src/interaction-report.ts` - non-sensitive aggregate interaction summary for `project_profile_status`.
- Modify: `src/plugin.ts` - records submitted prompts and structured lifecycle events, tracks session-local cancellations, registers interaction tools, and keeps every interaction operation fail-open.
- Modify: `src/report.ts` - appends aggregate interaction summary only, never raw interaction content.
- Modify: `src/index.ts` - exports newly introduced public helpers only when package conventions require it.
- Modify: `README.md` - documents data location, 90-day retention, local-text privacy, host support requirement, and the two interaction tools.
- Create: `test/interactions.test.ts` - schema, retention, workspace isolation, selection, deletion, malformed-row, and pair-boundary tests.
- Modify: `test/plugin.test.ts` - verifies registered interaction tools and plugin event handling.
- Modify: `test/report.test.ts` - verifies status includes counts and open requests but not prompt/draft text.

### Kilo repository: `/Users/liangchao/Downloads/kilocode`

- Create: `packages/opencode/src/kilocode/prompt/events.ts` - defines the Kilo-only EventV2 event schema and best-effort publisher for draft cancellation.
- Create: `packages/opencode/src/kilocode/server/prompt-events.ts` - validates the client payload and publishes the scoped EventV2 draft event.
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/instance.ts` and `packages/opencode/src/server/routes/instance/httpapi/handlers/instance.ts` - add the typed authenticated instance endpoint used by interactive clients to submit the event; regenerate `packages/sdk/js/` afterward.
- Modify: `packages/kilo-vscode/src/services/cli-backend/http-client.ts` and `packages/kilo-vscode/src/services/cli-backend/types.ts` - expose the generated endpoint through the extension client.
- Modify: `packages/kilo-vscode/src/KiloProvider.ts` and `packages/kilo-vscode/webview-ui/src/types/messages.ts` - forward a validated webview draft-cancelled message to the CLI without surfacing failures to the user.
- Modify: `packages/kilo-vscode/webview-ui/src/components/chat/PromptInput.tsx` - Escape on a non-empty unsent draft clears it, then sends one best-effort cancellation notification; ghost dismissal and assistant abort retain current behavior and emit nothing.
- Modify: `packages/tui/src/component/prompt/index.tsx` - make `prompt.clear` publish the current non-empty draft before clearing through the same Kilo backend publisher; non-draft clear paths do not publish.
- Create/modify focused tests beside the relevant package conventions - server endpoint/schema, plugin event forwarding, VS Code message handler, VS Code PromptInput, and TUI `prompt.clear` boundaries.

## Tasks

### Task 1: Build strict standalone interaction persistence

**Files:**
- Create: `src/interactions.ts`
- Create: `test/interactions.test.ts`

**Interfaces:**
- Produces `Interaction`, `InteractionType`, `interactionsPath(root)`, `loadInteractions(root)`, `recordInteraction(root, record)`, `selectInteractions(root, query)`, `forgetInteractions(root, query)`, and `summarizeInteractions(records, now)`.
- Consumes no Kilo code; all inputs are plain values and workspace paths.

- [ ] **Step 1: Write failing schema and persistence tests**

```ts
test("stores strict local interaction records and rejects unknown fields", async () => {
  const root = await tmpdir(dirs)
  await recordInteraction(root, {
    version: 1,
    at: "2026-08-13T00:00:00.000Z",
    sessionID: "ses_1",
    type: "prompt_submitted",
    text: "ship the release",
    kind: "prompt",
  })
  expect(await loadInteractions(root)).toHaveLength(1)
  expect(() => Interaction.parse({ version: 1, at: "2026-08-13T00:00:00.000Z", sessionID: "ses_1", type: "prompt_submitted", text: "x", kind: "prompt", extra: true })).toThrow()
})

test("retains the newest 1000 records inside 90 days per workspace", async () => {
  const root = await tmpdir(dirs)
  const at = "2026-08-13T00:00:00.000Z"
  await Bun.write(interactionsPath(root), [
    JSON.stringify({ version: 1, id: crypto.randomUUID(), at: "2026-05-01T00:00:00.000Z", sessionID: "ses_1", type: "prompt_submitted", text: "expired", kind: "prompt" }),
    ...Array.from({ length: 1_001 }, (_, index) => JSON.stringify({ version: 1, id: crypto.randomUUID(), at, sessionID: "ses_1", type: "prompt_submitted", text: String(index), kind: "prompt" })),
  ].join("\n") + "\n")
  await recordInteraction(root, { version: 1, at, sessionID: "ses_1", type: "prompt_submitted", text: "latest", kind: "prompt" })
  const rows = await loadInteractions(root)
  expect(rows).toHaveLength(1_000)
  expect(rows.at(-1)?.type).toBe("prompt_submitted")
})

test("skips malformed rows and removes only requested records", async () => {
  const root = await tmpdir(dirs)
  const first = await recordInteraction(root, { version: 1, at: "2026-08-13T00:00:00.000Z", sessionID: "ses_1", type: "draft_cancelled", text: "first" })
  await recordInteraction(root, { version: 1, at: "2026-08-13T00:00:01.000Z", sessionID: "ses_1", type: "draft_cancelled", text: "second" })
  await Bun.write(interactionsPath(root), `${await Bun.file(interactionsPath(root)).text()}not-json\n`)
  expect(await loadInteractions(root)).toHaveLength(2)
  await forgetInteractions(root, { id: first.id })
  expect(await loadInteractions(root)).toHaveLength(1)
  await forgetInteractions(root, { all: true })
  expect(await loadInteractions(root)).toEqual([])
})
```

- [ ] **Step 2: Run the new persistence tests to verify they fail**

Run: `bun test test/interactions.test.ts`

Expected: FAIL because `../src/interactions` does not exist.

- [ ] **Step 3: Implement the strict discriminated record schema and serialized append queue**

```ts
export const Interaction = z.discriminatedUnion("type", [
  z.object({ version: z.literal(1), id: z.string().uuid(), at: z.string().datetime(), sessionID: z.string().min(1), type: z.literal("prompt_submitted"), text: z.string(), kind: z.enum(["prompt", "command", "reply"]) }).strict(),
  z.object({ version: z.literal(1), id: z.string().uuid(), at: z.string().datetime(), sessionID: z.string().min(1), type: z.literal("question_opened"), requestID: z.string().min(1), question: z.string(), header: z.string().optional(), options: z.array(z.string()) }).strict(),
  z.object({ version: z.literal(1), id: z.string().uuid(), at: z.string().datetime(), sessionID: z.string().min(1), type: z.literal("question_closed"), requestID: z.string().min(1), status: z.enum(["answered", "rejected", "closed"]), answer: z.array(z.string()).optional() }).strict(),
  z.object({ version: z.literal(1), id: z.string().uuid(), at: z.string().datetime(), sessionID: z.string().min(1), type: z.literal("permission_opened"), requestID: z.string().min(1), tool: z.string().min(1), description: z.string().optional() }).strict(),
  z.object({ version: z.literal(1), id: z.string().uuid(), at: z.string().datetime(), sessionID: z.string().min(1), type: z.literal("permission_closed"), requestID: z.string().min(1), status: z.enum(["approved", "rejected", "closed"]) }).strict(),
  z.object({ version: z.literal(1), id: z.string().uuid(), at: z.string().datetime(), sessionID: z.string().min(1), type: z.literal("draft_cancelled"), text: z.string().min(1) }).strict(),
  z.object({ version: z.literal(1), id: z.string().uuid(), at: z.string().datetime(), sessionID: z.string().min(1), type: z.literal("draft_corrected"), cancelledAt: z.string().datetime(), cancelledText: z.string().min(1), correctedText: z.string() }).strict(),
])
```

Use the existing `events.ts` queue pattern, but keep all interaction code in this separate module and generate a `crypto.randomUUID()` ID when callers do not supply one. Select records in reverse chronological order, apply `types`, `pending`, `days`, and bounded `limit` filters, and rewrite retained rows atomically through the queue after deletion.

- [ ] **Step 4: Run persistence tests and typecheck**

Run: `bun test test/interactions.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the independently testable storage layer**

```bash
git add src/interactions.ts test/interactions.test.ts
git commit -m "feat: add local interaction records"
```

### Task 2: Capture plugin interactions and expose private explicit-query tools

**Files:**
- Modify: `src/plugin.ts`
- Modify: `src/report.ts`
- Create: `src/interaction-report.ts`
- Modify: `test/plugin.test.ts`
- Modify: `test/report.test.ts`
- Modify: `test/interactions.test.ts`

**Interfaces:**
- Consumes `recordInteraction`, `loadInteractions`, `selectInteractions`, `forgetInteractions`, and `summarizeInteractions` from `src/interactions.ts`.
- Produces tools `project_profile_interactions` and `project_profile_interactions_forget` in addition to the three existing preference tools.
- Consumes event properties `{ sessionID, text, at }` for `prompt.draft.cancelled` and current public `question.*` and `permission.*` event payloads.

- [ ] **Step 1: Write failing hook and report tests**

```ts
test("records a submitted prompt and one matching cancelled-draft correction", async () => {
  const hooks = await server({ worktree: root } as never)
  await hooks.event!({ event: { type: "prompt.draft.cancelled", properties: { sessionID: "ses_1", text: "teh plan", at: "2026-08-13T00:00:00.000Z" } } as never })
  await hooks["chat.message"]!({ sessionID: "ses_1" } as never, { parts: [{ type: "text", text: "the plan" }] } as never)
  expect((await loadInteractions(root)).map((item) => item.type)).toEqual(["draft_cancelled", "prompt_submitted", "draft_corrected"])
})

test("does not pair a correction at 10,001 milliseconds or across sessions", async () => {
  const hooks = await server({ worktree: root } as never)
  await hooks.event!({ event: { type: "prompt.draft.cancelled", properties: { sessionID: "ses_1", text: "old", at: "2026-08-13T00:00:00.000Z" } } as never })
  clock.set("2026-08-13T00:00:10.001Z")
  await hooks["chat.message"]!({ sessionID: "ses_1" } as never, { parts: [{ type: "text", text: "new" }] } as never)
  expect((await loadInteractions(root)).filter((item) => item.type === "draft_corrected")).toHaveLength(0)
})

test("reports open request counts without including stored text", () => {
  const output = interactionReport(records, Date.parse("2026-08-13T00:00:00.000Z"))
  expect(output).toContain("Open questions: 1")
  expect(output).not.toContain("secret prompt text")
})
```

- [ ] **Step 2: Run hook/report tests to verify they fail**

Run: `bun test test/plugin.test.ts test/report.test.ts test/interactions.test.ts`

Expected: FAIL because interaction tools, pairing, and summary code are not registered.

- [ ] **Step 3: Add one fail-open interaction recorder around existing hooks**

```ts
const pending = new Map<string, { at: number; text: string }>()

async event(input) {
  await skip(async () => {
    const item = input.event as { type: string; properties?: Record<string, unknown> }
    if (item.type === "prompt.draft.cancelled") {
      const value = DraftCancelled.parse(item.properties)
      await recordInteraction(worktree, { version: 1, id: crypto.randomUUID(), at: value.at, sessionID: value.sessionID, type: "draft_cancelled", text: value.text })
      pending.set(value.sessionID, { at: Date.parse(value.at), text: value.text })
      return
    }
    // Parse and persist only question/permission lifecycle events; ignore all other events.
  })
}
```

In `chat.message`, first append `prompt_submitted`, then consume the session's pending cancellation. Write `draft_corrected` only when `Date.now() - pending.at <= 10_000`; use the submitted text as `correctedText`; delete the pending item before returning. Existing preference matching must remain behaviorally identical and execute even when interaction recording fails.

For request events, use request IDs as correlation keys. Persist a structured open row from `question.asked`/`permission.asked`, then a close row only for the matching reply/rejection. Derive `status` only from structured reply data and use `closed` when a host lifecycle event has no clear approval/rejection status. Test each event explicitly with payloads for `question.asked`, `question.replied`, `question.rejected`, `permission.asked`, and `permission.replied`, asserting one open and one correlated close row for each request ID.

Add explicit tools:

```ts
project_profile_interactions: tool({
  description: "Show selected local project interaction records.",
  args: { days: tool.schema.number().int().positive().optional(), type: tool.schema.string().optional(), pending: tool.schema.boolean().optional(), limit: tool.schema.number().int().positive().max(100).optional() },
  async execute(args, ctx) { return JSON.stringify(await selectInteractions(ctx.worktree, args), null, 2) },
})

project_profile_interactions_forget: tool({
  description: "Forget local project interaction records.",
  args: { id: tool.schema.string().uuid().optional(), all: tool.schema.boolean().optional() },
  async execute(args, ctx) { /* require exactly one selector and delete only interaction rows */ },
})
```

`project_profile_status` calls `interactionReport` with loaded records and appends counts/open requests/latest timestamps only. It must not read or render the `text`, `question`, `answer`, or `description` fields.

- [ ] **Step 4: Run focused interaction tests and the existing suite**

Run: `bun test test/interactions.test.ts test/plugin.test.ts test/report.test.ts && bun test && bun run typecheck`

Expected: PASS with existing preference behavior unchanged.

- [ ] **Step 5: Commit plugin behavior and tools**

```bash
git add src/plugin.ts src/report.ts src/interaction-report.ts test/interactions.test.ts test/plugin.test.ts test/report.test.ts
git commit -m "feat: record local interaction learning"
```

### Task 3: Document and package the standalone interaction feature

**Files:**
- Modify: `README.md`
- Modify: `test/package.test.ts`

**Interfaces:**
- Consumes the tool names and interaction path from Tasks 1-2.
- Produces clear local-only usage and package-content assertions.

- [ ] **Step 1: Write failing package/readme assertions**

```ts
test("documents interaction storage and explicit data tools", async () => {
  const readme = await Bun.file("README.md").text()
  expect(readme).toContain(".kilo/project-profile-interactions.jsonl")
  expect(readme).toContain("project_profile_interactions")
  expect(readme).toContain("90 days")
})
```

- [ ] **Step 2: Run the package assertion to verify it fails**

Run: `bun test test/package.test.ts`

Expected: FAIL because the README does not yet list interaction storage or tools.

- [ ] **Step 3: Update the minimal README**

Document that prompt and draft text are retained locally in the active workspace for 90 days/1,000 records, are never sent to telemetry, appear only through explicit interaction queries, and require a compatible host to emit Escape draft cancellations. List both new tools and make no claim that cancellations are definitely voice recognition errors.

- [ ] **Step 4: Run complete standalone verification and package inspection**

Run: `bun test && bun run typecheck && npm pack --dry-run --json`

Expected: PASS; tarball contains only the declared package whitelist and never tests, docs, CI files, or repository metadata.

- [ ] **Step 5: Commit standalone documentation**

```bash
git add README.md test/package.test.ts
git commit -m "docs: describe local interaction data"
```

### Task 4: Define Kilo's validated draft-cancelled event

**Files:**
- Create: `packages/opencode/src/kilocode/prompt/events.ts`
- Create: `packages/opencode/test/kilocode/prompt/events.test.ts`

**Interfaces:**
- Produces an EventV2 event with exact payload `{ type: "prompt.draft.cancelled", properties: { sessionID: string; text: string; at: string } }`.
- Produces `KiloPromptEvents.cancelled(input)` that returns a best-effort Effect/promise publishing the EventV2 event in the current workspace context.
- The existing plugin event listener already forwards workspace-scoped EventV2 messages to `Hooks.event`; no shared dispatcher or published plugin API type change is needed.

- [ ] **Step 1: Write failing backend event tests**

```ts
test("publishes a typed draft cancellation event", async () => {
  const events = await captureEvents(async () => {
    await KiloPromptEvents.cancelled({ sessionID: "ses_1", text: "draft", at: "2026-08-13T00:00:00.000Z" })
  })
  expect(events).toContainEqual(expect.objectContaining({ type: "prompt.draft.cancelled", properties: { sessionID: "ses_1", text: "draft", at: "2026-08-13T00:00:00.000Z" } }))
})

test("rejects empty text and invalid timestamps before publication", async () => {
  await expect(KiloPromptEvents.cancelled({ sessionID: "ses_1", text: "", at: "invalid" })).rejects.toThrow()
})
```

- [ ] **Step 2: Run the backend event tests to verify they fail**

Run: `bun test test/kilocode/prompt/events.test.ts`

Expected: FAIL because the Kilo prompt event module does not exist.

- [ ] **Step 3: Implement the Kilo-only EventV2 definition and minimal forwarding change**

```ts
export const Cancelled = EventV2.define({
  type: "prompt.draft.cancelled",
  schema: {
    sessionID: Schema.String.pipe(Schema.minLength(1)),
    text: Schema.String.pipe(Schema.minLength(1)),
    at: Schema.DateTimeUtc,
  },
})
```

Publish it with the active `InstanceState` location so the existing plugin listener's directory filter delivers it only to plugins loaded for that workspace. Confirm the pre-existing listener in `packages/opencode/src/plugin/index.ts` forwards the EventV2 envelope as `{ id, type, properties }`; do not modify that shared dispatcher, the published `@opencode-ai/plugin` API, or client SSE payloads.

- [ ] **Step 4: Run focused backend tests and static checks**

Run: `bun test test/kilocode/prompt/events.test.ts && bun run typecheck && bun run script/check-opencode-annotations.ts --worktree`

Expected: PASS; annotation guard accepts all shared-file changes.

- [ ] **Step 5: Commit the typed plugin event contract**

```bash
git add packages/opencode/src/kilocode/prompt/events.ts packages/opencode/test/kilocode/prompt/events.test.ts
git commit -m "feat(cli): publish cancelled prompt drafts"
```

### Task 5: Add the backend endpoint and VS Code Escape forwarding

**Files:**
- Create: `packages/opencode/src/kilocode/server/prompt-events.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/*.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/*.ts`
- Regenerate: `packages/sdk/js/`
- Modify: `packages/kilo-vscode/src/services/cli-backend/types.ts`
- Modify: `packages/kilo-vscode/src/services/cli-backend/http-client.ts`
- Modify: `packages/kilo-vscode/src/KiloProvider.ts`
- Modify: `packages/kilo-vscode/webview-ui/src/types/messages.ts`
- Modify: `packages/kilo-vscode/webview-ui/src/components/chat/PromptInput.tsx`
- Create/modify: focused endpoint, provider, and PromptInput unit tests following existing package locations.

**Interfaces:**
- Consumes `KiloPromptEvents.cancelled({ sessionID, text, at })` from Task 4.
- Accepts authenticated local endpoint payload `{ sessionID: string; text: string; at: string }` and returns `204` after best-effort publication.
- Webview emits `{ type: "promptDraftCancelled", sessionID, text, at, agentManagerContext? }`; extension forwards it to its current CLI connection and intentionally does not surface a delivery error.

- [ ] **Step 1: Write failing endpoint and webview boundary tests**

```ts
it("forwards one non-empty Escape-cleared draft", async () => {
  renderPrompt({ text: "replace typo", sessionID: "ses_1" })
  await user.keyboard("{Escape}")
  expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: "promptDraftCancelled",
    sessionID: "ses_1",
    text: "replace typo",
  }))
})

it("does not report ghost dismissal or busy-turn abort as draft cancellation", async () => {
  renderPrompt({ text: "draft", sessionID: "ses_1", ghost: "completion" })
  await user.keyboard("{Escape}")
  expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "promptDraftCancelled" }))
  renderPrompt({ text: "draft", sessionID: "ses_1", busy: true })
  await user.keyboard("{Escape}")
  expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "promptDraftCancelled" }))
})

it("publishes the endpoint payload without returning host failures", async () => {
  publishCancelled.mockRejectedValueOnce(new Error("offline"))
  const response = await request.post("/prompt/draft-cancelled", { sessionID: "ses_1", text: "draft", at: "2026-08-13T00:00:00.000Z" })
  expect(response.status).toBe(204)
})
```

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `bun test test/kilocode/prompt/events.test.ts` from `packages/opencode/` and the focused VS Code unit-test command for the new PromptInput/provider tests.

Expected: FAIL because no endpoint or draft webview message exists.

- [ ] **Step 3: Implement endpoint, SDK regeneration, and best-effort extension forwarding**

The handler validates `sessionID`, non-empty `text`, and UTC `at` before calling the Kilo-only publisher. Catch/log publisher failures at the Kilo-only boundary and return no content so the UI cannot be blocked. Add the endpoint to the typed API group and run `./script/generate.ts` from repository root; do not edit SDK generated sources by hand.

In `PromptInput.tsx`, place the new branch after ghost dismissal and busy abort checks. Snapshot `text().trim()` and `sid()`; if either is empty, preserve the current Escape behavior without notifying. For a valid draft, clear the local text/draft maps/textarea height exactly once, then `vscode.postMessage` the draft event using `crypto.randomUUID()` only if the existing message conventions require request IDs. The extension's `KiloProvider` validates the message/session directory context and calls the new HTTP client method with a current ISO timestamp; it catches/logs failures and returns without an error notification.

- [ ] **Step 4: Run relevant SDK, CLI, and VS Code checks**

Run: `./script/generate.ts && bun --cwd packages/opencode run typecheck && bun --cwd packages/kilo-vscode run typecheck && bun --cwd packages/kilo-vscode run lint && bun --cwd packages/kilo-vscode run test:unit`

Expected: PASS. If endpoint changes affect source-link extraction, also run `bun run script/extract-source-links.ts` and commit its required output.

- [ ] **Step 5: Commit endpoint and VS Code forwarding**

```bash
git add packages/opencode packages/sdk/js packages/kilo-vscode
git commit -m "feat(vscode): report cancelled prompt drafts"
```

### Task 6: Emit the same event from TUI prompt clearing

**Files:**
- Modify: `packages/tui/src/component/prompt/index.tsx`
- Create/modify: focused TUI prompt tests using the existing `packages/tui` test pattern.

**Interfaces:**
- Consumes the Task 4 Kilo prompt publisher through a narrow Kilo-owned TUI helper or SDK request boundary.
- `prompt.clear` emits one event only for a non-empty unsent prompt and then preserves its existing clear/dialog behavior.

- [ ] **Step 1: Write failing TUI boundary tests**

```ts
test("prompt.clear publishes its non-empty unsent text once before clearing", async () => {
  const ui = await renderPrompt({ input: "keep this local", sessionID: "ses_1" })
  await ui.command("prompt.clear")
  expect(publishCancelled).toHaveBeenCalledWith(expect.objectContaining({ sessionID: "ses_1", text: "keep this local" }))
  expect(ui.input()).toBe("")
})

test("prompt.clear with an empty input does not publish", async () => {
  const ui = await renderPrompt({ input: "", sessionID: "ses_1" })
  await ui.command("prompt.clear")
  expect(publishCancelled).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the focused TUI tests to verify they fail**

Run: `bun test test/cli/tui/prompt-draft-cancelled.test.ts` from `packages/tui/`

Expected: FAIL because clearing does not publish a draft event.

- [ ] **Step 3: Add the smallest clear-path hook**

Capture and trim the current prompt inside the existing `prompt.clear` command before `clearPrompt()`. When non-empty and a session ID is available, invoke the Kilo publisher asynchronously with `void` and explicit failure logging. Do not bind raw Escape separately: the configured clear command remains the single behavior path. Do not emit for shell-mode exit, command submission, or assistant interruption.

- [ ] **Step 4: Run TUI and cross-package checks**

Run: `bun test test/cli/tui/prompt-draft-cancelled.test.ts && bun --cwd packages/tui run typecheck && bun run script/check-opencode-annotations.ts --worktree`

Expected: PASS.

- [ ] **Step 5: Commit the TUI client behavior**

```bash
git add packages/tui/src/component/prompt/index.tsx packages/tui/test/cli/tui/prompt-draft-cancelled.test.ts
git commit -m "feat(tui): report cleared prompt drafts"
```

### Task 7: Final integration verification, merge, and release

**Files:**
- Modify: standalone `package.json` only for the new release version.
- Create: standalone `.changeset/<slug>.md` only if the repository release policy requires a release-note artifact; otherwise do not add one.

**Interfaces:**
- Consumes all changes from Tasks 1-6.
- Produces merged `main` branches in both repositories and a published standalone npm version from a `main`-based tag.

- [ ] **Step 1: Run complete clean-worktree verification in both repositories**

Run in standalone repository: `bun test && bun run typecheck && npm pack --dry-run --json`

Run in Kilo repository: `bun --cwd packages/opencode run typecheck && bun --cwd packages/opencode test test/kilocode/prompt/events.test.ts && bun --cwd packages/kilo-vscode run typecheck && bun --cwd packages/kilo-vscode run lint && bun --cwd packages/kilo-vscode run test:unit && bun --cwd packages/tui run typecheck && bun run script/check-opencode-annotations.ts --worktree`

Expected: all checks pass. Diagnose and fix introduced failures before proceeding; do not modify unrelated dirty files in either normal checkout.

- [ ] **Step 2: Inspect final diffs and release contents**

```bash
git status --short
npm pack --dry-run --json
```

Expected: only intended source, tests, generated SDK artifacts, README, and release metadata changed; npm tarball excludes tests, docs, CI, and internal repository files.

- [ ] **Step 3: Merge validated branches into repository main branches**

For each repository, first inspect the normal checkout's `git status --short`, preserve pre-existing unrelated work, update from its local `main`, and merge the validated feature branch with a non-destructive non-interactive merge. Resolve only merge conflicts belonging to this feature; never reset, checkout, or revert unrelated user changes.

- [ ] **Step 4: Version, tag, and publish the standalone package from main**

```bash
npm version patch
```

Run these only from the standalone repository normal checkout after its `main` contains the merged, verified feature. Confirm npm's `latest` version after CI/OIDC publication. Do not publish from a feature branch/worktree and do not add a long-lived npm access token to repository secrets.

- [ ] **Step 5: Configure trusted publishing and revoke temporary credentials**

In npm package settings for `opencode-project-profile`, configure the GitHub Trusted Publisher with owner `bangbangmao666666`, repository `opencode-project-profile`, and workflow `.github/workflows/publish.yml`. Revoke the previously exposed granular token, particularly any token with bypass-2FA authority, after the OIDC workflow is confirmed.
