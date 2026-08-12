import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "./fixture/tmpdir"
import { empty, triggers } from "../src/schema"
import { lock, read, update } from "../src/store"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

test("returns an empty profile for a missing file", async () => {
  expect(await read(await tmpdir(dirs))).toEqual(empty())
})

test("ignores malformed profiles", async () => {
  const dir = await tmpdir(dirs)
  await fs.mkdir(path.join(dir, ".kilo"), { recursive: true })
  await Bun.write(path.join(dir, ".kilo", "project-profile.json"), "{not json")
  expect(await read(dir)).toBeUndefined()
})

test("keeps profiles isolated by workspace root", async () => {
  const first = await tmpdir(dirs)
  const second = await tmpdir(dirs)
  await update(first, (profile) => ({ ...profile, preferences: [sample()] }))
  expect((await read(first))?.preferences).toHaveLength(1)
  expect((await read(second))?.preferences).toEqual([])
})

test("skips updates while a fresh lock exists", async () => {
  const dir = await tmpdir(dirs)
  const file = lock(dir)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, JSON.stringify({ created: Date.now() }))
  expect(await update(dir, (profile) => ({ ...profile, preferences: [sample()] }))).toBeUndefined()
})

function sample() {
  return { id: triggers[0]!.id, triggers: [...triggers[0]!.phrases], meaning: triggers[0]!.meaning, status: "candidate" as const, confidence: 0.3, evidence: { accepted: 1, corrected: 0, lastSeen: new Date().toISOString() } }
}
