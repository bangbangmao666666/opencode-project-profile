import { tool, type Hooks, type Plugin } from "@opencode-ai/plugin"
import { anchor, inject, type Message } from "./context"
import * as Events from "./events"
import { observe } from "./learner"
import { report } from "./report"
import { match, normalize, triggers } from "./schema"
import * as Store from "./store"

type Turn = { id: string; anchor: boolean; tool: boolean; idle: boolean; injected: boolean }
const text = (parts: { type: string; text?: string }[]) => parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join(" ")
const correction = (value: string) => /^(do not|don't|dont|stop|cancel|not what i meant|that's not what i meant)\b/.test(normalize(value))

export const server: Plugin = async (input) => {
  const messages = new Map<string, Message[]>()
  const turns = new Map<string, Turn>()
  const skip = async (fn: () => Promise<void>) => fn().catch((err) => console.warn("project profile hook skipped", err))
  const record = async (id: string, kind: "accepted" | "corrected", injected: boolean) => {
    const trigger = triggers.find((item) => item.id === id)
    if (!trigger) return
    const at = new Date().toISOString()
    let events: Events.EventType[] = []
    const profile = await Store.update(input.worktree, (profile) => {
      const next = observe(profile, trigger, kind, at)
      events = next.events
      return next.profile
    })
    if (!profile) return
    await Promise.all([...events, ...(injected ? [kind] : [])].map((type) => Events.record(input.worktree, { version: 1, at, type, preference: id })))
  }
  return {
    tool: {
      project_profile_status: tool({ description: "Show learned project work preferences.", args: { today: tool.schema.boolean().optional(), days: tool.schema.number().int().positive().optional(), all: tool.schema.boolean().optional() }, async execute(args, ctx) { return report(await Store.read(ctx.worktree), Events.aggregate(await Events.load(ctx.worktree), Events.range(args))) } }),
      project_profile_disable: tool({ description: "Disable a learned project work preference.", args: { id: tool.schema.string() }, async execute(args, ctx) { await Store.update(ctx.worktree, (profile) => ({ ...profile, preferences: profile.preferences.map((item) => item.id === args.id ? { ...item, status: "disabled", confidence: 0 } : item) })); return `Disabled ${args.id}.` } }),
      project_profile_forget: tool({ description: "Forget learned project work preferences.", args: { id: tool.schema.string().optional() }, async execute(args, ctx) { await Store.update(ctx.worktree, (profile) => ({ ...profile, preferences: args.id ? profile.preferences.filter((item) => item.id !== args.id) : [] })); return args.id ? `Forgot ${args.id}.` : "Forgot all project preferences." } }),
    },
    async "experimental.chat.messages.transform"(_input, output) { await skip(async () => { for (const item of output.messages as unknown as Message[]) { const id = (item.info as { sessionID?: string }).sessionID; if (id) messages.set(id, output.messages as unknown as Message[]) } }) },
    async "chat.message"(event, output) { await skip(async () => { const value = text(output.parts as { type: string; text?: string }[]); const turn = turns.get(event.sessionID); if (turn) { turns.delete(event.sessionID); if (correction(value)) await record(turn.id, "corrected", turn.injected); else if (turn.anchor && turn.tool && turn.idle) await record(turn.id, "accepted", turn.injected) }; const trigger = match(value); if (trigger) turns.set(event.sessionID, { id: trigger.id, anchor: anchor(messages.get(event.sessionID) ?? []), tool: false, idle: false, injected: false }) }) },
    async "tool.execute.after"(event) { await skip(async () => { const turn = turns.get(event.sessionID); if (turn && !event.tool.startsWith("project_profile_")) turn.tool = true }) },
    async event(event) { await skip(async () => { const item = event.event as unknown as { type: string; properties?: { sessionID?: string; status?: { type?: string } } }; const id = item.properties?.sessionID; if (id && (item.type === "session.idle" || item.properties?.status?.type === "idle")) { const turn = turns.get(id); if (turn) turn.idle = true } }) },
    async "experimental.chat.system.transform"(event, output) { await skip(async () => { if (!event.sessionID) return; const current = messages.get(event.sessionID) ?? []; const value = (await Store.read(input.worktree)) && inject((await Store.read(input.worktree))!, text(current.at(-1)?.parts ?? []), current); if (!value) return; output.system.unshift(value); const turn = turns.get(event.sessionID); if (turn) { await Events.record(input.worktree, { version: 1, at: new Date().toISOString(), type: "injected", preference: turn.id }); turn.injected = true } }) },
  } satisfies Hooks
}
