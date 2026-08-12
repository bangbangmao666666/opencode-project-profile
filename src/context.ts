import { match, type Profile } from "./schema"

export type Message = { info: { role?: string }; parts: { type: string; text?: string }[] }

export function anchor(messages: Message[]) {
  const item = messages.toReversed().find((value) => value.info.role === "assistant")
  if (!item) return false
  const text = item.parts.filter((value) => value.type === "text").map((value) => value.text ?? "").join(" ")
  return /\b(recommend|suggest|next step|run)\b/i.test(text)
}

export function inject(profile: Profile, text: string, messages: Message[]) {
  const trigger = match(text)
  if (!trigger || !anchor(messages)) return
  const item = profile.preferences.find((value) => value.id === trigger.id && value.status === "active")
  if (!item) return
  return `Project work preference: ${trigger.id} means ${item.meaning} Existing permission and safety checks still apply.`.slice(0, 480)
}
