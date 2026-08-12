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

Different workspaces never share this data. The event log records only event version, UTC timestamp, event type, and preference ID. It has no telemetry or remote reporting.

## Tools

- `project_profile_status`
- `project_profile_disable`
- `project_profile_forget`
