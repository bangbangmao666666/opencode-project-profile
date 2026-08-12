import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import { aggregate, Event, eventsPath, load, range, record } from "../src/events"
import { tmpdir } from "./fixture/tmpdir"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

test("stores only safe event fields", async () => {
  const root = await tmpdir(dirs)
  await record(root, { version: 1, at: "2026-08-12T00:00:00.000Z", type: "injected", preference: "continue-current-work" })

  expect(JSON.parse(await Bun.file(eventsPath(root)).text())).toEqual({
    version: 1,
    at: "2026-08-12T00:00:00.000Z",
    type: "injected",
    preference: "continue-current-work",
  })
  expect(() => Event.parse({ version: 1, at: "2026-08-12T00:00:00.000Z", type: "injected", preference: "continue-current-work", prompt: "do not persist this" })).toThrow()
})

test("ignores malformed rows and aggregates a requested range", async () => {
  const root = await tmpdir(dirs)
  await fs.mkdir(`${root}/.kilo`, { recursive: true })
  await Bun.write(eventsPath(root), [
    '{"version":1,"at":"2026-08-10T00:00:00.000Z","type":"injected","preference":"continue-current-work"}',
    "not-json",
    '{"version":1,"at":"2026-08-10T00:01:00.000Z","type":"accepted","preference":"continue-current-work"}',
    '{"version":1,"at":"2026-07-01T00:00:00.000Z","type":"corrected","preference":"continue-current-work"}',
  ].join("\n") + "\n")

  const metrics = aggregate(await load(root), range({ days: 7, now: Date.parse("2026-08-10T12:00:00.000Z") }))
  expect(metrics.total).toMatchObject({ injected: 1, accepted: 1, corrected: 0 })
  expect(metrics.outcomeRate).toBe(1)
  expect(metrics.correctionRate).toBe(0)
})

test("keeps only the 1000 newest records within 90 days", async () => {
  const root = await tmpdir(dirs)
  await fs.mkdir(`${root}/.kilo`, { recursive: true })
  const at = "2026-08-12T00:00:00.000Z"
  const rows = [
    { version: 1, at: "2026-05-01T00:00:00.000Z", type: "injected", preference: "expired" },
    ...Array.from({ length: 1_001 }, (_, index) => ({ version: 1, at, type: "injected", preference: `current-${index}` })),
  ]
  await Bun.write(eventsPath(root), rows.map((item) => JSON.stringify(item)).join("\n") + "\n")

  await record(root, { version: 1, at, type: "accepted", preference: "latest" })
  const events = await load(root)
  expect(events).toHaveLength(1_000)
  expect(events.at(-1)?.preference).toBe("latest")
})

test("marks rates unavailable without their denominators", () => {
  const metrics = aggregate([], range({ all: true, now: Date.parse("2026-08-12T00:00:00.000Z") }))
  expect(metrics.activationRate).toBeUndefined()
  expect(metrics.outcomeRate).toBeUndefined()
  expect(metrics.correctionRate).toBeUndefined()
})

test("uses a distinct event log for each workspace", async () => {
  const first = await tmpdir(dirs)
  const second = await tmpdir(dirs)
  await record(first, { version: 1, at: "2026-08-12T00:00:00.000Z", type: "injected", preference: "continue-current-work" })
  expect(await load(first)).toHaveLength(1)
  expect(await load(second)).toEqual([])
})
