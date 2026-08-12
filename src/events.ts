import fs from "fs/promises"
import path from "path"
import { z } from "zod"

const MAX = 1_000
const AGE = 90 * 24 * 60 * 60 * 1_000
const queues = new Map<string, Promise<unknown>>()

export const Event = z.object({
  version: z.literal(1),
  at: z.string().datetime(),
  type: z.enum(["candidate_created", "activated", "injected", "accepted", "corrected", "disabled", "forgotten"]),
  preference: z.string().min(1),
}).strict()

export type Event = z.infer<typeof Event>
export type EventType = Event["type"]
export type Total = Record<EventType, number>
export type Range = { start?: number; end: number; label: string }
export type Metrics = {
  range: Range
  total: Total
  daily: Array<{ day: string; total: Total }>
  activationRate?: number
  outcomeRate?: number
  correctionRate?: number
  latest: { injected?: number; corrected?: number }
}

const zero = (): Total => ({
  candidate_created: 0,
  activated: 0,
  injected: 0,
  accepted: 0,
  corrected: 0,
  disabled: 0,
  forgotten: 0,
})

const day = (time: number) => new Date(time).toISOString().slice(0, 10)

export function eventsPath(root: string) {
  return path.join(root, ".kilo", "project-profile-events.jsonl")
}

export async function load(root: string): Promise<Event[]> {
  const text = await Bun.file(eventsPath(root)).text().catch(() => "")
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return []
    try {
      const value = Event.safeParse(JSON.parse(line))
      return value.success ? [value.data] : []
    } catch {
      return []
    }
  })
}

export async function record(root: string, event: Event) {
  const item = Event.parse(event)
  const previous = queues.get(root) ?? Promise.resolve()
  const next = previous.then(async () => {
    const file = eventsPath(root)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const events = [...await load(root), item]
    const kept = events.filter((value) => Date.parse(value.at) >= Date.parse(item.at) - AGE).slice(-MAX)
    await Bun.write(file, kept.map((value) => JSON.stringify(value)).join("\n") + "\n")
  })
  queues.set(root, next)
  return next.finally(() => {
    if (queues.get(root) === next) queues.delete(root)
  })
}

export function range(input: { today?: boolean; days?: number; all?: boolean; now?: number } = {}): Range {
  const now = input.now ?? Date.now()
  const end = Date.parse(`${day(now)}T00:00:00.000Z`) + 24 * 60 * 60 * 1_000
  if (input.all) return { end, label: "All retained history" }
  if (input.today) return { start: end - 24 * 60 * 60 * 1_000, end, label: "Today" }
  const days = input.days ?? 30
  return { start: end - days * 24 * 60 * 60 * 1_000, end, label: `Last ${days} days` }
}

export function aggregate(events: Event[], input: Range): Metrics {
  const total = zero()
  const days = new Map<string, Total>()
  const latest: Metrics["latest"] = {}
  for (const event of events) {
    const time = Date.parse(event.at)
    if ((input.start !== undefined && time < input.start) || time >= input.end) continue
    total[event.type]++
    const key = day(time)
    const daily = days.get(key) ?? zero()
    daily[event.type]++
    days.set(key, daily)
    if (event.type === "injected") latest.injected = Math.max(latest.injected ?? 0, time)
    if (event.type === "corrected") latest.corrected = Math.max(latest.corrected ?? 0, time)
  }
  const outcome = total.accepted + total.corrected
  return {
    range: input,
    total,
    daily: [...days].map(([day, total]) => ({ day, total })).sort((a, b) => b.day.localeCompare(a.day)),
    activationRate: total.candidate_created ? total.activated / total.candidate_created : undefined,
    outcomeRate: outcome ? total.accepted / outcome : undefined,
    correctionRate: total.injected ? total.corrected / total.injected : undefined,
    latest,
  }
}
