import { expect, test } from "bun:test"
import entry, { server } from "../src/index"

test("exports a standard OpenCode server plugin module", () => {
  expect(entry).toMatchObject({ id: "opencode.project-profile" })
  expect(entry.server).toBe(server)
})
