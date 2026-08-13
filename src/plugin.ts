import { tool, type Hooks, type Plugin } from "@opencode-ai/plugin"
import { z } from "zod"
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
const Timestamp = z.string().datetime().refine((value) => new Date(value).toISOString() === value)
const DraftCancelled = z.object({ sessionID: z.string().min(1), text: z.string().min(1), at: Timestamp }).strict()
const QuestionAsked = z.object({ id: z.string().min(1), sessionID: z.string().min(1), questions: z.array(z.object({ question: z.string().min(1), header: z.string().optional(), options: z.array(z.object({ label: z.string().min(1), description: z.string().optional() }).strict()) }).strict()).min(1) }).strict()
const QuestionReplied = z.object({ requestID: z.string().min(1), sessionID: z.string().min(1), answers: z.array(z.array(z.string())) }).strict()
const RequestClosed = z.object({ requestID: z.string().min(1), sessionID: z.string().min(1) }).strict()
const PermissionAsked = z.object({ id: z.string().min(1), sessionID: z.string().min(1), permission: z.string().min(1), patterns: z.array(z.string()), metadata: z.object({ description: z.string().optional() }).strict().optional(), always: z.array(z.string()) }).strict()
const PermissionReplied = z.object({ requestID: z.string().min(1), sessionID: z.string().min(1), reply: z.string().min(1) }).strict()
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
      project_profile_interactions: tool({ description: "Show selected local project interaction records.", args: { days: tool.schema.number().int().positive().optional(), type: tool.schema.string().optional(), pending: tool.schema.boolean().optional(), limit: tool.schema.number().int().positive().max(100).optional() }, async execute(args, ctx) { return JSON.stringify(await selectInteractions(ctx.worktree, { days: args.days, types: args.type ? [args.type as never] : undefined, pending: args.pending, limit: args.limit }).catch((err) => { console.warn("project profile interaction query skipped", err); return "Local interactions are unavailable." }), null, 2) } }),
      project_profile_interactions_forget: tool({ description: "Forget local project interaction records.", args: { id: tool.schema.string().uuid().optional(), all: tool.schema.boolean().optional() }, async execute(args, ctx) { return await forgetInteractions(ctx.worktree, args).then(() => args.all ? "Forgot all local interactions." : `Forgot ${args.id}.`).catch((err) => { console.warn("project profile interaction forget skipped", err); return "Local interactions are unavailable." }) } }),
    },
    async "experimental.chat.messages.transform"(_input, output) { await skip(async () => { for (const item of output.messages as unknown as Message[]) { const id = (item.info as { sessionID?: string }).sessionID; if (id) messages.set(id, output.messages as unknown as Message[]) } }) },
    async "chat.message"(event, output) {
      const value = text(output.parts as { type: string; text?: string }[])
      await skip(async () => {
        const draft = pending.get(event.sessionID)
        pending.delete(event.sessionID)
        await recordInteraction(input.worktree, { version: 1, at: new Date().toISOString(), sessionID: event.sessionID, type: "prompt_submitted", text: value, kind: "prompt" })
        if (draft) {
          const age = Date.now() - draft.at
          if (age >= 0 && age <= 10_000) await recordInteraction(input.worktree, { version: 1, at: new Date().toISOString(), sessionID: event.sessionID, type: "draft_corrected", cancelledAt: new Date(draft.at).toISOString(), cancelledText: draft.text, correctedText: value })
        }
      })
      await skip(async () => { const turn = turns.get(event.sessionID); if (turn) { turns.delete(event.sessionID); if (correction(value)) await record(turn.id, "corrected", turn.injected); else if (turn.anchor && turn.tool && turn.idle) await record(turn.id, "accepted", turn.injected) }; const trigger = match(value); if (trigger) turns.set(event.sessionID, { id: trigger.id, anchor: anchor(messages.get(event.sessionID) ?? []), tool: false, idle: false, injected: false }) })
    },
    async "tool.execute.after"(event) { await skip(async () => { const turn = turns.get(event.sessionID); if (turn && !event.tool.startsWith("project_profile_")) turn.tool = true }) },
    async event(event) {
      const item = event.event as unknown as { type: string; properties?: Record<string, unknown> & { sessionID?: string; status?: { type?: string } } }
      await skip(async () => {
        const at = new Date().toISOString()
        if (item.type === "prompt.draft.cancelled") { const value = DraftCancelled.parse(item.properties); await recordInteraction(input.worktree, { version: 1, at: value.at, sessionID: value.sessionID, type: "draft_cancelled", text: value.text }); pending.set(value.sessionID, { at: Date.parse(value.at), text: value.text }); return }
        if (item.type === "question.asked") { const value = QuestionAsked.parse(item.properties); const question = value.questions[0]!; await recordInteraction(input.worktree, { version: 1, at, sessionID: value.sessionID, type: "question_opened", requestID: value.id, question: question.question, header: question.header, options: question.options.map((item) => item.label) }); questions.set(value.id, { sessionID: value.sessionID }); return }
        if (item.type === "question.replied") { const value = QuestionReplied.parse(item.properties); if (questions.get(value.requestID)?.sessionID !== value.sessionID) return; questions.delete(value.requestID); await recordInteraction(input.worktree, { version: 1, at, sessionID: value.sessionID, type: "question_closed", requestID: value.requestID, status: "answered", answer: value.answers.flat() }); return }
        if (item.type === "question.rejected" || item.type === "question.closed") { const value = RequestClosed.parse(item.properties); if (questions.get(value.requestID)?.sessionID !== value.sessionID) return; questions.delete(value.requestID); await recordInteraction(input.worktree, { version: 1, at, sessionID: value.sessionID, type: "question_closed", requestID: value.requestID, status: item.type === "question.rejected" ? "rejected" : "closed" }); return }
        if (item.type === "permission.asked") { const value = PermissionAsked.parse(item.properties); await recordInteraction(input.worktree, { version: 1, at, sessionID: value.sessionID, type: "permission_opened", requestID: value.id, tool: value.permission, description: value.metadata?.description }); permissions.set(value.id, { sessionID: value.sessionID }); return }
        if (item.type === "permission.replied") { const value = PermissionReplied.parse(item.properties); if (permissions.get(value.requestID)?.sessionID !== value.sessionID) return; permissions.delete(value.requestID); await recordInteraction(input.worktree, { version: 1, at, sessionID: value.sessionID, type: "permission_closed", requestID: value.requestID, status: value.reply === "reject" ? "rejected" : value.reply === "once" || value.reply === "always" ? "approved" : "closed" }); return }
        if (item.type === "permission.closed") { const value = RequestClosed.parse(item.properties); if (permissions.get(value.requestID)?.sessionID !== value.sessionID) return; permissions.delete(value.requestID); await recordInteraction(input.worktree, { version: 1, at, sessionID: value.sessionID, type: "permission_closed", requestID: value.requestID, status: "closed" }) }
      })
      await skip(async () => { const id = item.properties?.sessionID; if (id && (item.type === "session.idle" || item.properties?.status?.type === "idle")) { const turn = turns.get(id); if (turn) turn.idle = true } })
    },
    async "experimental.chat.system.transform"(event, output) { await skip(async () => { if (!event.sessionID) return; const current = messages.get(event.sessionID) ?? []; const value = (await Store.read(input.worktree)) && inject((await Store.read(input.worktree))!, text(current.at(-1)?.parts ?? []), current); if (!value) return; output.system.unshift(value); const turn = turns.get(event.sessionID); if (turn) { await Events.record(input.worktree, { version: 1, at: new Date().toISOString(), type: "injected", preference: turn.id }); turn.injected = true } }) },
  } satisfies Hooks
}
