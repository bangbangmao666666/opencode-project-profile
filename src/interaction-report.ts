import { summarizeInteractions, type Interaction } from "./interactions"

export function interactionReport(records: Interaction[], now = Date.now()) {
  const summary = summarizeInteractions(records, now)
  return [
    `Local interactions: ${summary.total}`,
    `Open questions: ${summary.openQuestions}`,
    `Open permissions: ${summary.openPermissions}`,
    `Latest interaction: ${summary.latest === undefined ? "none" : new Date(summary.latest).toISOString()}`,
  ].join("\n")
}
