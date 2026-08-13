import { afterEach, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import { loadInteractions } from "../src/interactions"
import { server } from "../src/plugin"
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

test("status includes aggregate interaction data without raw prompt text", async () => {
  const root = await tmpdir(dirs)
  const hooks = await server({ worktree: root } as never)
  await hooks["chat.message"]!({ sessionID: "ses_1" } as never, { parts: [{ type: "text", text: "secret prompt text" }] } as never)
  const value = await hooks.tool!.project_profile_status.execute({}, { worktree: root } as never)
  expect(value).toContain("Local interactions: 1")
  expect(value).not.toContain("secret prompt text")
})
