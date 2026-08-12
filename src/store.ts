import fs from "fs/promises"
import nodePath from "path"
import { expire } from "./learner"
import { empty, parse, type Profile } from "./schema"

const queues = new Map<string, Promise<unknown>>()
const STALE = 60_000

export function path(root: string) {
  return nodePath.join(root, ".kilo", "project-profile.json")
}

export function lock(root: string) {
  return `${path(root)}.lock`
}

export async function read(root: string): Promise<Profile | undefined> {
  const text = await Bun.file(path(root)).text().catch(() => undefined)
  if (text === undefined) return empty()
  try {
    return parse(JSON.parse(text))
  } catch (err) {
    console.warn("project profile ignored", err)
  }
}

export async function update(root: string, change: (profile: Profile) => Profile, now = new Date().toISOString()): Promise<Profile | undefined> {
  const previous = queues.get(root) ?? Promise.resolve()
  const next = previous.then(async () => {
    const file = path(root)
    const handle = await acquire(file)
    if (!handle) return
    try {
      const profile = await read(root)
      if (!profile) return
      const value = change(expire(profile, now))
      const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
      await Bun.write(temp, JSON.stringify(value, undefined, 2) + "\n")
      await fs.rename(temp, file)
      return value
    } catch (err) {
      console.warn("project profile update skipped", err)
    } finally {
      await handle.close()
      await fs.rm(lock(root), { force: true }).catch((err) => console.warn("project profile lock cleanup failed", err))
    }
  })
  queues.set(root, next)
  return next.finally(() => {
    if (queues.get(root) === next) queues.delete(root)
  })
}

async function acquire(file: string) {
  const target = `${file}.lock`
  await fs.mkdir(nodePath.dirname(file), { recursive: true })
  const handle = await fs.open(target, "wx").catch(async (err: NodeJS.ErrnoException) => {
    if (err.code !== "EEXIST") throw err
    const text = await Bun.file(target).text().catch(() => undefined)
    const created = (() => {
      try {
        return text ? JSON.parse(text).created : undefined
      } catch (err) {
        console.warn("project profile lock ignored", err)
      }
    })()
    if (typeof created !== "number" || Date.now() - created <= STALE) return
    await fs.rm(target, { force: true })
    return fs.open(target, "wx")
  })
  if (!handle) return
  await handle.writeFile(JSON.stringify({ created: Date.now() }))
  return handle
}
