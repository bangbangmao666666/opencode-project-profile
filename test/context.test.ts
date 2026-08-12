import { expect, test } from "bun:test"
import { inject } from "../src/context"
import { empty, triggers } from "../src/schema"

test("injects only active preference after recommendation", () => {
  const profile = { ...empty(), preferences: [{ id: triggers[0]!.id, triggers: [...triggers[0]!.phrases], meaning: triggers[0]!.meaning, status: "active" as const, confidence: 0.9, evidence: { accepted: 3, corrected: 0, lastSeen: new Date().toISOString() } }] }
  expect(inject(profile, "continue", [{ info: { role: "assistant" }, parts: [{ type: "text", text: "I recommend testing." }] }])).toContain("continue-current-work")
})
