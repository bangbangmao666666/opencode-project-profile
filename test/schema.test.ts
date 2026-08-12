import { describe, expect, test } from "bun:test"
import { empty, match, normalize, parse } from "../src/schema"

describe("project preference triggers", () => {
  test("normalizes case and surrounding whitespace", () => {
    expect(normalize("  Continue  ")).toBe("continue")
  })

  test("matches only supported complete trigger phrases", () => {
    expect(match("continue")?.id).toBe("continue-current-work")
    expect(match("follow your recommendation")?.id).toBe("adopt-recommendation")
    expect(match("package and install directly")?.id).toBe("run-local-workflow")
  })

  test("does not match negated, extended, or unknown messages", () => {
    expect(match("do not continue")).toBeUndefined()
    expect(match("continue after I review the diff")).toBeUndefined()
    expect(match("ship this")).toBeUndefined()
  })

  test("accepts only the current profile version", () => {
    expect(parse(empty()).version).toBe(1)
    expect(() => parse({ version: 2, preferences: [] })).toThrow()
  })

  test("ignores legacy metrics from version-one profiles", () => {
    expect(parse({ version: 1, preferences: [], metrics: [] })).toEqual(empty())
  })
})
