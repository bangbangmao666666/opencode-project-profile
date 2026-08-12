import type { PluginModule } from "@opencode-ai/plugin"
import { server } from "./plugin"

const entry = { id: "opencode.project-profile", server } satisfies PluginModule

export { server }
export default entry
