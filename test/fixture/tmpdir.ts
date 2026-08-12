import fs from "fs/promises"
import path from "path"

export async function tmpdir(dirs: string[]) {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "opencode-project-profile-"))
  dirs.push(dir)
  return dir
}
