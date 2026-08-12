import { z } from "zod"

export const triggers = [
  {
    id: "continue-current-work",
    phrases: ["continue", "continue working"],
    meaning: "Continue the current task along the most recently recommended remaining steps. Do not repeat ordinary execution confirmation.",
  },
  {
    id: "adopt-recommendation",
    phrases: ["follow your recommendation", "do it your way"],
    meaning: "Implement the most recently stated, unambiguous recommendation.",
  },
  {
    id: "run-local-workflow",
    phrases: ["package and install directly"],
    meaning: "Use the project's standard local build, package, and installation workflow.",
  },
] as const

export type Trigger = (typeof triggers)[number]
export type Status = "candidate" | "active" | "disabled"

export const Preference = z.object({
  id: z.string(),
  triggers: z.array(z.string()).min(1),
  meaning: z.string(),
  status: z.enum(["candidate", "active", "disabled"]),
  confidence: z.number().min(0).max(0.95),
  evidence: z.object({
    accepted: z.number().int().nonnegative(),
    corrected: z.number().int().nonnegative(),
    lastSeen: z.string().datetime(),
  }),
})

export const Profile = z.object({
  version: z.literal(1),
  preferences: z.array(Preference),
})

export type Preference = z.infer<typeof Preference>
export type Profile = z.infer<typeof Profile>

export function empty(): Profile {
  return { version: 1, preferences: [] }
}

export function parse(value: unknown): Profile {
  return Profile.parse(value)
}

export function normalize(text: string) {
  return text.trim().replace(/\s+/g, " ").toLowerCase()
}

export function match(text: string): Trigger | undefined {
  const value = normalize(text)
  if (/^(do not|don't|dont|stop|cancel)\b/.test(value)) return
  return triggers.find((item) => item.phrases.includes(value as never))
}
