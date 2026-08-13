import { afterEach, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import {
  forgetInteractions,
  Interaction,
  interactionsPath,
  loadInteractions,
  recordInteraction,
  selectInteractions,
  summarizeInteractions,
} from "../src/interactions"
import { tmpdir } from "./fixture/tmpdir"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

test("stores strict local interaction records and rejects unknown fields", async () => {
  const root = await tmpdir(dirs)
  const at = new Date(Date.now()).toISOString()
  await recordInteraction(root, {
    version: 1,
    at,
    sessionID: "ses_1",
    type: "prompt_submitted",
    text: "ship the release",
    kind: "prompt",
  })

  expect(await loadInteractions(root)).toHaveLength(1)
  expect(() => Interaction.parse({ version: 1, at, sessionID: "ses_1", type: "prompt_submitted", text: "x", kind: "prompt", extra: true })).toThrow()
})

test("retains the newest 1000 records inside 90 days per workspace", async () => {
  const root = await tmpdir(dirs)
  const now = Date.now()
  const at = new Date(now).toISOString()
  await fs.mkdir(`${root}/.kilo`, { recursive: true })
  await Bun.write(interactionsPath(root), [
    JSON.stringify({ version: 1, id: crypto.randomUUID(), at: new Date(now - 91 * 24 * 60 * 60 * 1_000).toISOString(), sessionID: "ses_1", type: "prompt_submitted", text: "expired", kind: "prompt" }),
    ...Array.from({ length: 1_001 }, (_, index) => JSON.stringify({ version: 1, id: crypto.randomUUID(), at, sessionID: "ses_1", type: "prompt_submitted", text: String(index), kind: "prompt" })),
  ].join("\n") + "\n")
  await recordInteraction(root, { version: 1, at, sessionID: "ses_1", type: "prompt_submitted", text: "latest", kind: "prompt" })

  const rows = await loadInteractions(root)
  expect(rows).toHaveLength(1_000)
  expect(rows.at(-1)?.type).toBe("prompt_submitted")
})

test("retains an appended record when 1000 existing records have the same timestamp", async () => {
  const root = await tmpdir(dirs)
  const at = new Date(Date.now()).toISOString()
  await fs.mkdir(`${root}/.kilo`, { recursive: true })
  await Bun.write(interactionsPath(root), Array.from({ length: 1_000 }, (_, index) => JSON.stringify({
    version: 1,
    id: `ffffffff-ffff-4fff-8fff-${index.toString().padStart(12, "0")}`,
    at,
    sessionID: "ses_1",
    type: "prompt_submitted",
    text: String(index),
    kind: "prompt",
  })).join("\n") + "\n")
  await recordInteraction(root, {
    version: 1,
    id: "00000000-0000-4000-8000-000000000000",
    at,
    sessionID: "ses_1",
    type: "prompt_submitted",
    text: "appended",
    kind: "prompt",
  })

  const rows = await loadInteractions(root)
  expect(rows).toHaveLength(1_000)
  expect(rows.at(-1)?.id).toBe("00000000-0000-4000-8000-000000000000")
})

test("uses the current time for retention instead of a future appended record", async () => {
  const root = await tmpdir(dirs)
  const now = Date.now()
  await fs.mkdir(`${root}/.kilo`, { recursive: true })
  await Bun.write(interactionsPath(root), `${JSON.stringify({ version: 1, id: crypto.randomUUID(), at: new Date(now - 89 * 24 * 60 * 60 * 1_000).toISOString(), sessionID: "ses_1", type: "prompt_submitted", text: "recent", kind: "prompt" })}\n`)

  const date = Date.now
  Date.now = () => now
  try {
    await recordInteraction(root, { version: 1, at: new Date(now + 24 * 60 * 60 * 1_000).toISOString(), sessionID: "ses_1", type: "prompt_submitted", text: "future", kind: "prompt" })
  } finally {
    Date.now = date
  }

  expect((await loadInteractions(root)).filter((item) => item.type === "prompt_submitted").map((item) => item.text)).toEqual(["recent", "future"])
})

test("retains the actual newest 1000 records when input is unordered", async () => {
  const root = await tmpdir(dirs)
  const now = Date.now()
  const rows = Array.from({ length: 1_000 }, (_, index) => ({
    version: 1 as const,
    id: crypto.randomUUID(),
    at: new Date(now - index * 1_000).toISOString(),
    sessionID: "ses_1",
    type: "prompt_submitted" as const,
    text: String(index),
    kind: "prompt" as const,
  }))
  await fs.mkdir(`${root}/.kilo`, { recursive: true })
  await Bun.write(interactionsPath(root), [...rows].reverse().map((item) => JSON.stringify(item)).join("\n") + "\n")
  await recordInteraction(root, { version: 1, at: new Date(now - 2_000_000).toISOString(), sessionID: "ses_1", type: "prompt_submitted", text: "backdated", kind: "prompt" })

  const retained = await loadInteractions(root)
  expect(retained).toHaveLength(1_000)
  expect(retained.filter((item) => item.type === "prompt_submitted").map((item) => item.text)).toEqual([...rows].reverse().map((item) => item.text))
})

test("continues queued writes after an earlier write fails", async () => {
  const root = await tmpdir(dirs)
  const now = Date.now()
  const write = spyOn(Bun, "write")
  write.mockRejectedValueOnce(new Error("failed write"))
  try {
    const first = recordInteraction(root, { version: 1, at: new Date(now).toISOString(), sessionID: "ses_1", type: "draft_cancelled", text: "failed" })
    const second = recordInteraction(root, { version: 1, at: new Date(now + 1).toISOString(), sessionID: "ses_1", type: "draft_cancelled", text: "saved" })
    const failed = expect(first).rejects.toThrow("failed write")
    const saved = expect(second).resolves.toMatchObject({ text: "saved" })

    await failed
    await saved
  } finally {
    write.mockRestore()
  }
  expect((await loadInteractions(root)).filter((item) => item.type === "draft_cancelled").map((item) => item.text)).toEqual(["saved"])
})

test("preserves every concurrently recorded interaction", async () => {
  const root = await tmpdir(dirs)
  const now = Date.now()
  await Promise.all(Array.from({ length: 20 }, (_, index) => recordInteraction(root, {
    version: 1,
    at: new Date(now + index).toISOString(),
    sessionID: "ses_1",
    type: "draft_cancelled",
    text: String(index),
  })))

  expect((await loadInteractions(root)).filter((item) => item.type === "draft_cancelled").map((item) => item.text).sort()).toEqual(Array.from({ length: 20 }, (_, index) => String(index)).sort())
})

test("skips malformed rows and removes only requested records", async () => {
  const root = await tmpdir(dirs)
  const now = Date.now()
  const first = await recordInteraction(root, { version: 1, at: new Date(now).toISOString(), sessionID: "ses_1", type: "draft_cancelled", text: "first" })
  await recordInteraction(root, { version: 1, at: new Date(now + 1).toISOString(), sessionID: "ses_1", type: "draft_cancelled", text: "second" })
  await Bun.write(interactionsPath(root), `${await Bun.file(interactionsPath(root)).text()}not-json\n`)

  expect(await loadInteractions(root)).toHaveLength(2)
  await forgetInteractions(root, { id: first.id })
  expect(await loadInteractions(root)).toHaveLength(1)
  await forgetInteractions(root, { all: true })
  expect(await loadInteractions(root)).toEqual([])
})

test("isolates records by workspace and selects matching records newest first", async () => {
  const first = await tmpdir(dirs)
  const second = await tmpdir(dirs)
  const now = Date.now()
  await recordInteraction(first, { version: 1, at: new Date(now - 24 * 60 * 60 * 1_000).toISOString(), sessionID: "ses_1", type: "prompt_submitted", text: "old", kind: "prompt" })
  await recordInteraction(first, { version: 1, at: new Date(now).toISOString(), sessionID: "ses_1", type: "draft_cancelled", text: "new" })

  expect(await loadInteractions(second)).toEqual([])
  expect((await selectInteractions(first, { types: ["draft_cancelled"], days: 1, limit: 1, now: now + 12 * 60 * 60 * 1_000 })).map((item) => item.type === "draft_cancelled" ? item.text : undefined)).toEqual(["new"])
})

test("selects pending requests and summarizes only aggregate interaction data", async () => {
  const root = await tmpdir(dirs)
  const now = Date.now()
  await recordInteraction(root, { version: 1, at: new Date(now).toISOString(), sessionID: "ses_1", type: "question_opened", requestID: "req_1", question: "secret question", options: [] })
  await recordInteraction(root, { version: 1, at: new Date(now + 1).toISOString(), sessionID: "ses_1", type: "permission_opened", requestID: "req_2", tool: "shell", description: "secret description" })
  await recordInteraction(root, { version: 1, at: new Date(now + 2).toISOString(), sessionID: "ses_1", type: "question_closed", requestID: "req_1", status: "answered", answer: ["secret answer"] })

  const rows = await loadInteractions(root)
  expect((await selectInteractions(root, { pending: true })).map((item) => item.type)).toEqual(["permission_opened"])
  expect(summarizeInteractions(rows, now + 12 * 60 * 60 * 1_000)).toEqual({ total: 3, openQuestions: 0, openPermissions: 1, latest: now + 2 })
})
