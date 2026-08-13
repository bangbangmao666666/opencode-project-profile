import { expect, test } from "bun:test"
import { aggregate, range } from "../src/events"
import { interactionReport } from "../src/interaction-report"
import { report } from "../src/report"
import { empty } from "../src/schema"

test("renders local profile state without estimates", () => {
  const metrics = aggregate([{ version: 1, at: "2026-08-10T00:00:00.000Z", type: "injected", preference: "continue-current-work" }], range({ all: true, now: Date.parse("2026-08-10T12:00:00.000Z") }))
  const value = report(empty(), metrics)
  expect(value).toContain("Project profile metrics: All retained history")
  expect(value).toContain("Correction rate: 0.0%")
  expect(value).not.toContain("Estimated")
})

test("reports open request counts without including stored interaction text", () => {
  const value = interactionReport([
    { version: 1, id: crypto.randomUUID(), at: "2026-08-13T00:00:00.000Z", sessionID: "ses_1", type: "prompt_submitted", text: "secret prompt text", kind: "prompt" },
    { version: 1, id: crypto.randomUUID(), at: "2026-08-13T00:00:00.000Z", sessionID: "ses_1", type: "draft_cancelled", text: "secret draft" },
    { version: 1, id: crypto.randomUUID(), at: "2026-08-13T00:00:00.000Z", sessionID: "ses_1", type: "draft_corrected", cancelledAt: "2026-08-13T00:00:00.000Z", cancelledText: "secret draft", correctedText: "secret correction" },
    { version: 1, id: crypto.randomUUID(), at: "2026-08-13T00:00:00.000Z", sessionID: "ses_1", type: "question_opened", requestID: "req_1", question: "secret question", options: [] },
  ], Date.parse("2026-08-13T00:00:00.000Z"))
  expect(value).toContain("Open questions: 1")
  expect(value).toContain("Submitted prompts: 1")
  expect(value).toContain("Cancelled drafts: 1")
  expect(value).toContain("Correction pairs: 1")
  expect(value).not.toContain("secret prompt text")
  expect(value).not.toContain("secret question")
  expect(value).not.toContain("secret draft")
  expect(value).not.toContain("secret correction")
})
