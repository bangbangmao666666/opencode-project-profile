import { expect, test } from "bun:test"
import { aggregate, range } from "../src/events"
import { report } from "../src/report"
import { empty } from "../src/schema"

test("renders local profile state without estimates", () => {
  const metrics = aggregate([{ version: 1, at: "2026-08-10T00:00:00.000Z", type: "injected", preference: "continue-current-work" }], range({ all: true, now: Date.parse("2026-08-10T12:00:00.000Z") }))
  const value = report(empty(), metrics)
  expect(value).toContain("Project profile metrics: All retained history")
  expect(value).toContain("Correction rate: 0.0%")
  expect(value).not.toContain("Estimated")
})
