import { expect, test } from "bun:test"
import { expire, observe } from "../src/learner"
import { empty, triggers } from "../src/schema"

const trigger = triggers[0]!
const now = "2026-08-10T06:06:42.000Z"

test("promotes after three acceptances", () => {
  const profile = [1, 2, 3].reduce((value) => observe(value, trigger, "accepted", now).profile, empty())
  expect(profile.preferences[0]?.status).toBe("active")
})

test("disables active preference after two corrections", () => {
  const active = [1, 2, 3].reduce((value) => observe(value, trigger, "accepted", now).profile, empty())
  const profile = [1, 2].reduce((value) => observe(value, trigger, "corrected", now).profile, active)
  expect(profile.preferences[0]?.status).toBe("disabled")
})

test("expires stale candidates", () => {
  const profile = observe(empty(), trigger, "accepted", "2026-01-01T00:00:00.000Z").profile
  expect(expire(profile, now).preferences).toEqual([])
})
