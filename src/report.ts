import type { Metrics } from "./events"
import { interactionReport } from "./interaction-report"
import type { Interaction } from "./interactions"
import type { Profile } from "./schema"

const percent = (value: number | undefined) => value === undefined ? "unavailable" : `${(value * 100).toFixed(1)}%`
const date = (value: number | undefined) => value === undefined ? "none" : new Date(value).toISOString()

export function report(profile: Profile | undefined, metrics: Metrics, interactions?: Interaction[]) {
  const preferences = profile?.preferences ?? []
  return [
    `Project profile metrics: ${metrics.range.label}`,
    `Profile exists: ${profile ? "yes" : "no"}`,
    `Candidate preferences: ${preferences.filter((item) => item.status === "candidate").length}`,
    `Active preferences: ${preferences.filter((item) => item.status === "active").length}`,
    `Disabled preferences: ${preferences.filter((item) => item.status === "disabled").length}`,
    `Candidates created: ${metrics.total.candidate_created}`,
    `Activations: ${metrics.total.activated}`,
    `Context injections: ${metrics.total.injected}`,
    `Accepted outcomes: ${metrics.total.accepted}`,
    `Corrected outcomes: ${metrics.total.corrected}`,
    `Activation conversion: ${percent(metrics.activationRate)}`,
    `Outcome rate: ${percent(metrics.outcomeRate)}`,
    `Correction rate: ${percent(metrics.correctionRate)}`,
    `Latest injection: ${date(metrics.latest.injected)}`,
    `Latest correction: ${date(metrics.latest.corrected)}`,
    ...(interactions ? [interactionReport(interactions)] : []),
  ].join("\n")
}
