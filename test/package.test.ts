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

test("publishes only plugin runtime artifacts", async () => {
  const proc = Bun.spawn(["npm", "pack", "--dry-run", "--json"], { cwd: import.meta.dir + "/..", stdout: "pipe" })
  const text = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  const files = (JSON.parse(text)[0].files as { path: string }[]).map((item) => item.path).sort()
  expect(files).toEqual([
    "LICENSE",
    "README.md",
    "package.json",
    "src/context.ts",
    "src/events.ts",
    "src/index.ts",
    "src/interactions.ts",
    "src/learner.ts",
    "src/plugin.ts",
    "src/report.ts",
    "src/schema.ts",
    "src/store.ts",
  ])
})
