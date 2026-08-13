import { afterEach, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import { loadInteractions } from "../src/interactions"
import { server } from "../src/plugin"
import * as Store from "../src/store"
import { tmpdir } from "./fixture/tmpdir"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

test("registers profile hooks and management tools", async () => {
  const hooks = await server({ worktree: "/tmp/project-profile" } as never)
  expect(hooks["chat.message"]).toBeTypeOf("function")
  expect(hooks.tool).toEqual(expect.objectContaining({
    project_profile_status: expect.any(Object),
    project_profile_disable: expect.any(Object),
    project_profile_forget: expect.any(Object),
    project_profile_interactions: expect.any(Object),
    project_profile_interactions_forget: expect.any(Object),
  }))
  expect(hooks.tool).not.toHaveProperty("project_profile_report")
})

test("records a submitted prompt and one matching cancelled-draft correction", async () => {
  const root = await tmpdir(dirs)
  const hooks = await server({ worktree: root } as never)
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-13T00:00:10.000Z"))
  await hooks.event!({ event: { type: "prompt.draft.cancelled", properties: { sessionID: "ses_1", text: "teh plan", at: "2026-08-13T00:00:00.000Z" } } as never })
  await hooks["chat.message"]!({ sessionID: "ses_1" } as never, { parts: [{ type: "text", text: "the plan" }] } as never)
  clock.mockRestore()
  expect((await loadInteractions(root)).map((item) => item.type)).toEqual(["draft_cancelled", "prompt_submitted", "draft_corrected"])
})

test("consumes a cancelled draft when the first subsequent prompt write fails", async () => {
  const root = await tmpdir(dirs)
  const hooks = await server({ worktree: root } as never)
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-13T00:00:10.000Z"))
  await hooks.event!({ event: { type: "prompt.draft.cancelled", properties: { sessionID: "ses_1", text: "teh plan", at: "2026-08-13T00:00:00.000Z" } } as never })
  const write = spyOn(Bun, "write").mockRejectedValueOnce(new Error("interaction write failed"))
  try {
    await hooks["chat.message"]!({ sessionID: "ses_1" } as never, { parts: [{ type: "text", text: "the plan" }] } as never)
    await hooks["chat.message"]!({ sessionID: "ses_1" } as never, { parts: [{ type: "text", text: "the revised plan" }] } as never)
  } finally {
    write.mockRestore()
    clock.mockRestore()
  }
  expect((await loadInteractions(root)).filter((item) => item.type === "draft_corrected")).toEqual([])
})

test("does not pair a correction after 10,000 milliseconds or across sessions", async () => {
  const root = await tmpdir(dirs)
  const hooks = await server({ worktree: root } as never)
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-13T00:00:10.001Z"))
  await hooks.event!({ event: { type: "prompt.draft.cancelled", properties: { sessionID: "ses_1", text: "old", at: "2026-08-13T00:00:00.000Z" } } as never })
  await hooks["chat.message"]!({ sessionID: "ses_2" } as never, { parts: [{ type: "text", text: "other" }] } as never)
  await hooks["chat.message"]!({ sessionID: "ses_1" } as never, { parts: [{ type: "text", text: "new" }] } as never)
  clock.mockRestore()
  expect((await loadInteractions(root)).filter((item) => item.type === "draft_corrected")).toHaveLength(0)
})

test("does not pair future or non-ISO draft cancellations", async () => {
  const root = await tmpdir(dirs)
  const hooks = await server({ worktree: root } as never)
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-13T00:00:10.000Z"))
  await hooks.event!({ event: { type: "prompt.draft.cancelled", properties: { sessionID: "ses_1", text: "future", at: "2026-08-13T00:00:10.001Z" } } as never })
  await hooks["chat.message"]!({ sessionID: "ses_1" } as never, { parts: [{ type: "text", text: "current" }] } as never)
  await hooks.event!({ event: { type: "prompt.draft.cancelled", properties: { sessionID: "ses_1", text: "invalid", at: "August 13, 2026" } } as never })
  await hooks["chat.message"]!({ sessionID: "ses_1" } as never, { parts: [{ type: "text", text: "next" }] } as never)
  clock.mockRestore()
  expect((await loadInteractions(root)).filter((item) => item.type === "draft_corrected")).toEqual([])
})

test("records correlated question and permission lifecycle events", async () => {
  const root = await tmpdir(dirs)
  const hooks = await server({ worktree: root } as never)
  const event = async (type: string, properties: Record<string, unknown>) => hooks.event!({ event: { type, properties } as never })
  await event("question.asked", { id: "question_1", sessionID: "ses_1", questions: [{ question: "Pick one", header: "Choice", options: [{ label: "One", description: "First" }] }] })
  await event("question.replied", { requestID: "question_1", sessionID: "ses_1", answers: [["One"]] })
  await event("question.asked", { id: "question_2", sessionID: "ses_1", questions: [{ question: "Continue?", header: "Continue", options: [] }] })
  await event("question.rejected", { requestID: "question_2", sessionID: "ses_1" })
  await event("permission.asked", { id: "permission_1", sessionID: "ses_1", permission: "shell", patterns: [], metadata: { description: "Run command" }, always: [] })
  await event("permission.replied", { requestID: "permission_1", sessionID: "ses_1", reply: "once" })
  expect((await loadInteractions(root)).map((item) => item.type)).toEqual([
    "question_opened", "question_closed", "question_opened", "question_closed", "permission_opened", "permission_closed",
  ])
})

test("ignores malformed lifecycle events and closes unknown permission replies", async () => {
  const root = await tmpdir(dirs)
  const hooks = await server({ worktree: root } as never)
  const event = async (type: string, properties: Record<string, unknown>) => hooks.event!({ event: { type, properties } as never })
  await event("question.asked", { id: "question_1", sessionID: "ses_1", questions: [{ question: "Pick one", options: [] }], unexpected: true })
  await event("permission.asked", { id: "permission_1", sessionID: "ses_1", permission: "shell", patterns: [], metadata: { description: "Run command" }, always: [] })
  await event("permission.replied", { requestID: "permission_1", sessionID: "ses_1", reply: "unexpected" })
  expect(await loadInteractions(root)).toMatchObject([
    { type: "permission_opened", requestID: "permission_1" },
    { type: "permission_closed", requestID: "permission_1", status: "closed" },
  ])
})

test("preserves preference learning when interaction recording fails", async () => {
  const root = await tmpdir(dirs)
  const hooks = await server({ worktree: root } as never)
  const write = spyOn(Bun, "write").mockRejectedValueOnce(new Error("interaction write failed"))
  try {
    await hooks["experimental.chat.messages.transform"]!({} as never, { messages: [{ info: { sessionID: "ses_1", role: "assistant" }, parts: [{ type: "text", text: "Recommended next step" }] }] } as never)
    await hooks["chat.message"]!({ sessionID: "ses_1" } as never, { parts: [{ type: "text", text: "continue" }] } as never)
    await hooks["tool.execute.after"]!({ sessionID: "ses_1", tool: "shell" } as never, {} as never)
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })
    await hooks["chat.message"]!({ sessionID: "ses_1" } as never, { parts: [{ type: "text", text: "next" }] } as never)
  } finally {
    write.mockRestore()
  }
  expect((await Store.read(root))?.preferences).toMatchObject([{ id: "continue-current-work", evidence: { accepted: 1 } }])
})

test("interaction tools select and forget only interaction records", async () => {
  const root = await tmpdir(dirs)
  const hooks = await server({ worktree: root } as never)
  await hooks["chat.message"]!({ sessionID: "ses_1" } as never, { parts: [{ type: "text", text: "private prompt" }] } as never)
  const ctx = { worktree: root } as never
  const output = await hooks.tool!.project_profile_interactions.execute({}, ctx)
  expect(typeof output).toBe("string")
  const rows = JSON.parse(output as string)
  await hooks.tool!.project_profile_interactions_forget.execute({ id: rows[0].id }, ctx)
  expect(await loadInteractions(root)).toEqual([])
})

test("interaction query and forget tools fail open on storage errors", async () => {
  const root = await tmpdir(dirs)
  const hooks = await server({ worktree: root } as never)
  const ctx = { worktree: root } as never
  const read = spyOn(fs, "readFile").mockRejectedValueOnce(new Error("read failed"))
  try {
    await expect(hooks.tool!.project_profile_interactions.execute({}, ctx)).resolves.toContain("unavailable")
  } finally {
    read.mockRestore()
  }
  const write = spyOn(Bun, "write").mockRejectedValueOnce(new Error("write failed"))
  try {
    await expect(hooks.tool!.project_profile_interactions_forget.execute({ all: true }, ctx)).resolves.toContain("unavailable")
  } finally {
    write.mockRestore()
  }
})

test("status includes aggregate interaction data without raw prompt text", async () => {
  const root = await tmpdir(dirs)
  const hooks = await server({ worktree: root } as never)
  await hooks["chat.message"]!({ sessionID: "ses_1" } as never, { parts: [{ type: "text", text: "secret prompt text" }] } as never)
  const value = await hooks.tool!.project_profile_status.execute({}, { worktree: root } as never)
  expect(value).toContain("Local interactions: 1")
  expect(value).not.toContain("secret prompt text")
})
