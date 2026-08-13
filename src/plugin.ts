import { tool, type Hooks, type Plugin } from "@opencode-ai/plugin"
import { anchor, inject, type Message } from "./context"
import * as Events from "./events"
import { observe } from "./learner"
import { forgetInteractions, loadInteractions, recordInteraction, selectInteractions } from "./interactions"
import { report } from "./report"
import { match, normalize, triggers } from "./schema"
import * as Store from "./store"

type Turn = { id: string; anchor: boolean; tool: boolean; idle: boolean; injected: boolean }
type Draft = { at: number; text: string }
type Request = { sessionID: string }
const text = (parts: { type: string; text?: string }[]) => parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join(" ")
const correction = (value: string) => /^(do not|don't|dont|stop|cancel|not what i meant|that's not what i meant)\b/.test(normalize(value))

export const server: Plugin = async (input) => {
  const messages = new Map<string, Message[]>()
  const turns = new Map<string, Turn>()
  const pending = new Map<string, Draft>()
  const questions = new Map<string, Request>()
  const permissions = new Map<string, Request>()
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
      project_profile_status: tool({ description: "Show learned project work preferences.", args: { today: tool.schema.boolean().optional(), days: tool.schema.number().int().positive().optional(), all: tool.schema.boolean().optional() }, async execute(args, ctx) { const profile = await Store.read(ctx.worktree); const metrics = Events.aggregate(await Events.load(ctx.worktree), Events.range(args)); const interactions = await loadInteractions(ctx.worktree).catch((err) => { console.warn("project profile interaction status skipped", err); return undefined }); return report(profile, metrics, interactions) } }),
      project_profile_disable: tool({ description: "Disable a learned project work preference.", args: { id: tool.schema.string() }, async execute(args, ctx) { await Store.update(ctx.worktree, (profile) => ({ ...profile, preferences: profile.preferences.map((item) => item.id === args.id ? { ...item, status: "disabled", confidence: 0 } : item) })); return `Disabled ${args.id}.` } }),
      project_profile_forget: tool({ description: "Forget learned project work preferences.", args: { id: tool.schema.string().optional() }, async execute(args, ctx) { await Store.update(ctx.worktree, (profile) => ({ ...profile, preferences: args.id ? profile.preferences.filter((item) => item.id !== args.id) : [] })); return args.id ? `Forgot ${args.id}.` : "Forgot all project preferences." } }),
      project_profile_interactions: tool({ description: "Show selected local project interaction records.", args: { days: tool.schema.number().int().positive().optional(), type: tool.schema.string().optional(), pending: tool.schema.boolean().optional(), limit: tool.schema.number().int().positive().max(100).optional() }, async execute(args, ctx) { return JSON.stringify(await selectInteractions(ctx.worktree, { days: args.days, types: args.type ? [args.type as never] : undefined, pending: args.pending, limit: args.limit }), null, 2) } }),
      project_profile_interactions_forget: tool({ description: "Forget local project interaction records.", args: { id: tool.schema.string().uuid().optional(), all: tool.schema.boolean().optional() }, async execute(args, ctx) { await forgetInteractions(ctx.worktree, args); return args.all ? "Forgot all local interactions." : `Forgot ${args.id}.` } }),
    },
    async "experimental.chat.messages.transform"(_input, output) { await skip(async () => { for (const item of output.messages as unknown as Message[]) { const id = (item.info as { sessionID?: string }).sessionID; if (id) messages.set(id, output.messages as unknown as Message[]) } }) },
    async "chat.message"(event, output) {
      const value = text(output.parts as { type: string; text?: string }[])
      await skip(async () => {
        await recordInteraction(input.worktree, { version: 1, at: new Date().toISOString(), sessionID: event.sessionID, type: "prompt_submitted", text: value, kind: "prompt" })
        const draft = pending.get(event.sessionID)
        pending.delete(event.sessionID)
        if (draft && Date.now() - draft.at <= 10_000) await recordInteraction(input.worktree, { version: 1, at: new Date().toISOString(), sessionID: event.sessionID, type: "draft_corrected", cancelledAt: new Date(draft.at).toISOString(), cancelledText: draft.text, correctedText: value })
      })
      await skip(async () => { const turn = turns.get(event.sessionID); if (turn) { turns.delete(event.sessionID); if (correction(value)) await record(turn.id, "corrected", turn.injected); else if (turn.anchor && turn.tool && turn.idle) await record(turn.id, "accepted", turn.injected) }; const trigger = match(value); if (trigger) turns.set(event.sessionID, { id: trigger.id, anchor: anchor(messages.get(event.sessionID) ?? []), tool: false, idle: false, injected: false }) })
    },
    async "tool.execute.after"(event) { await skip(async () => { const turn = turns.get(event.sessionID); if (turn && !event.tool.startsWith("project_profile_")) turn.tool = true }) },
    async event(event) {
      const item = event.event as unknown as { type: string; properties?: Record<string, unknown> & { sessionID?: string; status?: { type?: string } } }
      await skip(async () => {
        const value = item.properties
        if (!value) return
        const id = typeof value.sessionID === "string" ? value.sessionID : undefined
        const request = typeof value.id === "string" ? value.id : typeof value.requestID === "string" ? value.requestID : undefined
        const at = new Date().toISOString()
        if (item.type === "prompt.draft.cancelled" && id && typeof value.text === "string" && value.text && typeof value.at === "string" && !Number.isNaN(Date.parse(value.at))) { await recordInteraction(input.worktree, { version: 1, at: value.at, sessionID: id, type: "draft_cancelled", text: value.text }); pending.set(id, { at: Date.parse(value.at), text: value.text }); return }
        if (item.type === "question.asked" && id && request && Array.isArray(value.questions)) { const question = value.questions[0] as { question?: unknown; header?: unknown; options?: unknown } | undefined; if (!question || typeof question.question !== "string" || !Array.isArray(question.options)) return; await recordInteraction(input.worktree, { version: 1, at, sessionID: id, type: "question_opened", requestID: request, question: question.question, header: typeof question.header === "string" ? question.header : undefined, options: question.options.flatMap((item) => typeof (item as { label?: unknown }).label === "string" ? [(item as { label: string }).label] : []) }); questions.set(request, { sessionID: id }); return }
        if ((item.type === "question.replied" || item.type === "question.rejected" || item.type === "question.closed") && id && request && questions.get(request)?.sessionID === id) { questions.delete(request); await recordInteraction(input.worktree, { version: 1, at, sessionID: id, type: "question_closed", requestID: request, status: item.type === "question.replied" ? "answered" : item.type === "question.rejected" ? "rejected" : "closed", answer: item.type === "question.replied" && Array.isArray(value.answers) ? value.answers.flatMap((item) => Array.isArray(item) ? item.filter((value): value is string => typeof value === "string") : []) : undefined }); return }
        if (item.type === "permission.asked" && id && request && typeof value.permission === "string") { await recordInteraction(input.worktree, { version: 1, at, sessionID: id, type: "permission_opened", requestID: request, tool: value.permission, description: typeof (value.metadata as { description?: unknown } | undefined)?.description === "string" ? (value.metadata as { description: string }).description : undefined }); permissions.set(request, { sessionID: id }); return }
        if ((item.type === "permission.replied" || item.type === "permission.closed") && id && request && permissions.get(request)?.sessionID === id) { permissions.delete(request); await recordInteraction(input.worktree, { version: 1, at, sessionID: id, type: "permission_closed", requestID: request, status: item.type === "permission.replied" ? value.reply === "reject" ? "rejected" : "approved" : "closed" }) }
      })
      await skip(async () => { const id = item.properties?.sessionID; if (id && (item.type === "session.idle" || item.properties?.status?.type === "idle")) { const turn = turns.get(id); if (turn) turn.idle = true } })
    },
    async "experimental.chat.system.transform"(event, output) { await skip(async () => { if (!event.sessionID) return; const current = messages.get(event.sessionID) ?? []; const value = (await Store.read(input.worktree)) && inject((await Store.read(input.worktree))!, text(current.at(-1)?.parts ?? []), current); if (!value) return; output.system.unshift(value); const turn = turns.get(event.sessionID); if (turn) { await Events.record(input.worktree, { version: 1, at: new Date().toISOString(), type: "injected", preference: turn.id }); turn.injected = true } }) },
  } satisfies Hooks
}
