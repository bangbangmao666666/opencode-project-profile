import { expect, test } from "bun:test"
import { server } from "../src/plugin"

test("registers profile hooks and management tools", async () => {
  const hooks = await server({ worktree: "/tmp/project-profile" } as never)
  expect(hooks["chat.message"]).toBeTypeOf("function")
  expect(hooks.tool).toEqual(expect.objectContaining({
    project_profile_status: expect.any(Object),
    project_profile_disable: expect.any(Object),
    project_profile_forget: expect.any(Object),
  }))
  expect(hooks.tool).not.toHaveProperty("project_profile_report")
})
