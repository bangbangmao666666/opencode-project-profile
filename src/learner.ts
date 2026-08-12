import type { EventType } from "./events"
import type { Profile, Trigger } from "./schema"

const EXPIRES = 30 * 24 * 60 * 60 * 1_000

export function observe(profile: Profile, trigger: Trigger, kind: "accepted" | "corrected", now: string) {
  const item = profile.preferences.find((value) => value.id === trigger.id)
  const base = item ?? { id: trigger.id, triggers: [...trigger.phrases], meaning: trigger.meaning, status: "candidate" as const, confidence: 0, evidence: { accepted: 0, corrected: 0, lastSeen: now } }
  const evidence = { accepted: base.evidence.accepted + (kind === "accepted" ? 1 : 0), corrected: base.evidence.corrected + (kind === "corrected" ? 1 : 0), lastSeen: now }
  const status = base.status === "active" && evidence.corrected >= 2 ? "disabled" : evidence.accepted >= 3 && evidence.corrected === 0 ? "active" : base.status
  const next = { ...base, status, confidence: status === "disabled" ? 0 : Math.min(0.95, Math.max(0, evidence.accepted * 0.3 - evidence.corrected * 0.5)), evidence }
  const events: EventType[] = []
  if (!item) events.push("candidate_created")
  if (item?.status !== "active" && next.status === "active") events.push("activated")
  if (item?.status !== "disabled" && next.status === "disabled") events.push("disabled")
  return { profile: { ...profile, preferences: item ? profile.preferences.map((value) => value.id === next.id ? next : value) : [...profile.preferences, next] }, events }
}

export function expire(profile: Profile, now: string): Profile {
  const time = Date.parse(now)
  return { ...profile, preferences: profile.preferences.filter((item) => item.status !== "candidate" || time - Date.parse(item.evidence.lastSeen) < EXPIRES) }
}
