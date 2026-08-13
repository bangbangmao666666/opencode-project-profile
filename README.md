# opencode-project-profile

Local workspace preference learning for OpenCode-compatible plugin hosts.

## Install

Add the package to the host's global plugin configuration:

```json
{ "plugin": ["opencode-project-profile"] }
```

## Workspace Data

The plugin stores data only in the active workspace:

- `.kilo/project-profile.json`
- `.kilo/project-profile-events.jsonl`
- `.kilo/project-profile-interactions.jsonl`

Different workspaces never share this data. The event log records only event version, UTC timestamp, event type, and preference ID. It has no telemetry or remote reporting.

## Interaction Data

Submitted prompt text, structured question and permission requests, and cancelled drafts are stored only in the active workspace. This sensitive text is never sent to telemetry and appears only when explicitly requested through an interaction query. Interaction records are retained for up to 90 days and 1,000 records.

Cancelled drafts require a compatible host to emit an Escape-cleared non-empty draft event. A cancellation followed by a replacement may indicate a possible voice-input correction, but is not treated as proof of voice input.

## Tools

- `project_profile_status`
- `project_profile_disable`
- `project_profile_forget`
- `project_profile_interactions`
- `project_profile_interactions_forget`
