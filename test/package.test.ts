import { expect, test } from "bun:test"

test("declares an independent public plugin package", async () => {
  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json() as Record<string, unknown>
  expect(pkg.name).toBe("opencode-project-profile")
  expect(pkg.license).toBe("MIT")
  expect(pkg.private).toBe(false)
  expect(pkg.dependencies).toEqual({ zod: expect.any(String) })
  expect(pkg.peerDependencies).toEqual({ "@opencode-ai/plugin": expect.any(String) })
  expect(JSON.stringify(pkg)).not.toContain("@kilocode/")
  expect(JSON.stringify(pkg)).not.toContain("workspace:")
})
