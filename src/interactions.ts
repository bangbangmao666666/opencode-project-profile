import fs from "fs/promises"
import path from "path"
import { z } from "zod"

const MAX = 1_000
const AGE = 90 * 24 * 60 * 60 * 1_000
const queues = new Map<string, Promise<unknown>>()

export const Interaction = z.discriminatedUnion("type", [
  z.object({ version: z.literal(1), id: z.string().uuid(), at: z.string().datetime(), sessionID: z.string().min(1), type: z.literal("prompt_submitted"), text: z.string(), kind: z.enum(["prompt", "command", "reply"]) }).strict(),
  z.object({ version: z.literal(1), id: z.string().uuid(), at: z.string().datetime(), sessionID: z.string().min(1), type: z.literal("question_opened"), requestID: z.string().min(1), question: z.string(), header: z.string().optional(), options: z.array(z.string()) }).strict(),
  z.object({ version: z.literal(1), id: z.string().uuid(), at: z.string().datetime(), sessionID: z.string().min(1), type: z.literal("question_closed"), requestID: z.string().min(1), status: z.enum(["answered", "rejected", "closed"]), answer: z.array(z.string()).optional() }).strict(),
  z.object({ version: z.literal(1), id: z.string().uuid(), at: z.string().datetime(), sessionID: z.string().min(1), type: z.literal("permission_opened"), requestID: z.string().min(1), tool: z.string().min(1), description: z.string().optional() }).strict(),
  z.object({ version: z.literal(1), id: z.string().uuid(), at: z.string().datetime(), sessionID: z.string().min(1), type: z.literal("permission_closed"), requestID: z.string().min(1), status: z.enum(["approved", "rejected", "closed"]) }).strict(),
  z.object({ version: z.literal(1), id: z.string().uuid(), at: z.string().datetime(), sessionID: z.string().min(1), type: z.literal("draft_cancelled"), text: z.string().min(1) }).strict(),
  z.object({ version: z.literal(1), id: z.string().uuid(), at: z.string().datetime(), sessionID: z.string().min(1), type: z.literal("draft_corrected"), cancelledAt: z.string().datetime(), cancelledText: z.string().min(1), correctedText: z.string() }).strict(),
])

export type Interaction = z.infer<typeof Interaction>
export type InteractionType = Interaction["type"]
export type InteractionInput = Interaction extends infer Item ? Item extends { id: string } ? Omit<Item, "id"> & { id?: string } : never : never
export type InteractionQuery = {
  types?: InteractionType[]
  pending?: boolean
  days?: number
  limit?: number
  now?: number
}

export function interactionsPath(root: string) {
  return path.join(root, ".kilo", "project-profile-interactions.jsonl")
}

export async function loadInteractions(root: string): Promise<Interaction[]> {
  const text = await fs.readFile(interactionsPath(root), "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return ""
    throw err
  })
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return []
    try {
      const value = Interaction.safeParse(JSON.parse(line))
      return value.success ? [value.data] : []
    } catch {
      return []
    }
  })
}

export async function recordInteraction(root: string, record: InteractionInput) {
  const item = Interaction.parse({ ...record, id: record.id ?? crypto.randomUUID() })
  await update(root, async () => {
    const rows = [...await loadInteractions(root), item]
    return rows
      .filter((value) => Date.parse(value.at) >= Date.now() - AGE)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .slice(-MAX)
  })
  return item
}

export async function selectInteractions(root: string, query: InteractionQuery = {}) {
  const rows = await loadInteractions(root)
  const open = pending(rows)
  const start = query.days === undefined ? undefined : (query.now ?? Date.now()) - query.days * 24 * 60 * 60 * 1_000
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 100)
  return rows
    .filter((item) => !query.types || query.types.includes(item.type))
    .filter((item) => start === undefined || Date.parse(item.at) >= start)
    .filter((item) => query.pending === undefined || open.has(item.id) === query.pending)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit)
}

export async function forgetInteractions(root: string, query: { id?: string; all?: boolean }) {
  if ((query.id === undefined) === (query.all !== true)) throw new Error("select one interaction or all interactions")
  await update(root, async () => query.all ? [] : (await loadInteractions(root)).filter((item) => item.id !== query.id))
}

export function summarizeInteractions(records: Interaction[], _now = Date.now()) {
  const open = pending(records)
  const rows = records.filter((item) => open.has(item.id))
  const latest = records.reduce<number | undefined>((value, item) => Math.max(value ?? 0, Date.parse(item.at)), undefined)
  return {
    total: records.length,
    submittedPrompts: records.filter((item) => item.type === "prompt_submitted").length,
    cancelledDrafts: records.filter((item) => item.type === "draft_cancelled").length,
    correctionPairs: records.filter((item) => item.type === "draft_corrected").length,
    openQuestions: rows.filter((item) => item.type === "question_opened").length,
    openPermissions: rows.filter((item) => item.type === "permission_opened").length,
    latest,
  }
}

function pending(records: Interaction[]) {
  const open = new Map<string, Interaction>()
  for (const item of records) {
    if (item.type === "question_opened" || item.type === "permission_opened") open.set(`${item.type}:${item.requestID}`, item)
    if (item.type === "question_closed") open.delete(`question_opened:${item.requestID}`)
    if (item.type === "permission_closed") open.delete(`permission_opened:${item.requestID}`)
  }
  return new Set([...open.values()].map((item) => item.id))
}

async function update(root: string, change: () => Promise<Interaction[]>) {
  const previous = queues.get(root) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(async () => {
    const file = interactionsPath(root)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const rows = await change()
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
    await Bun.write(temp, rows.map((item) => JSON.stringify(item)).join("\n") + (rows.length ? "\n" : ""))
    await fs.rename(temp, file)
  })
  queues.set(root, next)
  return next.finally(() => {
    if (queues.get(root) === next) queues.delete(root)
  })
}
