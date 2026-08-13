# Interaction Learning Design

## Goal

Extend `opencode-project-profile` with workspace-local interaction records that
show:

- User-submitted prompts.
- Questions and permission requests that need user input, plus their closure.
- Draft text cleared with Escape and the next submitted text that corrects it.

The feature remains local-only and keeps its data separate from learned project
preferences and their aggregate metrics.

## Scope

The standalone plugin owns the interaction schema, persistence, retention,
matching, reporting, and deletion behavior. Kilo owns only a new plugin event
that reports a non-empty prompt draft cleared with Escape.

The feature does not infer whether a draft originated from speech recognition.
It records the observable fact: a draft was cancelled and quickly replaced. The
report may describe these as possible voice-input corrections, never as a
guaranteed transcription failure.

## Data

Store content records at:

```text
.kilo/project-profile-interactions.jsonl
```

Each record is strict JSON with `version`, UTC `at`, `sessionID`, and `type`.
The version is independent from the existing preference profile and event-log
versions.

| Type | Fields | Meaning |
|---|---|---|
| `prompt_submitted` | `text`, `kind` | A user message accepted by the host. |
| `question_opened` | `requestID`, `question`, `header`, `options` | A structured question requiring input. |
| `question_closed` | `requestID`, `status`, optional `answer` | The question was answered, rejected, or otherwise closed. |
| `permission_opened` | `requestID`, `tool`, optional `description` | A structured permission request requiring a decision. |
| `permission_closed` | `requestID`, `status` | The permission was approved, rejected, or otherwise closed. |
| `draft_cancelled` | `text` | A non-empty prompt draft was cleared with Escape. |
| `draft_corrected` | `cancelledAt`, `cancelledText`, `correctedText` | The first subsequent submitted prompt in the same session corrected a cancelled draft. |

The interaction log retains at most 1,000 records and records no older than 90
days. Retention is evaluated whenever the plugin appends an interaction.

The log can contain sensitive natural-language text. It is never uploaded,
included in telemetry, shared between workspaces, or copied into
`project-profile-events.jsonl`.

## Host Event

Add one public plugin event to Kilo's plugin event stream:

```ts
{
  type: "prompt.draft.cancelled"
  properties: {
    sessionID: string
    text: string
    at: string
  }
}
```

The TUI and VS Code prompt inputs emit this event only when Escape clears a
non-empty unsent draft. The event is emitted after the UI clears the draft, is
best effort, and must not block the input operation. Empty drafts do not emit
events. Aborting an already submitted assistant turn is not a draft
cancellation and must not emit this event.

The event carries no source label such as `voice`; the host cannot reliably
determine the input method.

## Plugin Flow

### Submitted prompts

On `chat.message`, the plugin extracts the text parts of the accepted user
message and writes a `prompt_submitted` record. The `kind` records whether the
message is a normal prompt, command, or structured reply when the host exposes
that distinction; otherwise it uses `prompt`.

### Pending user input

The plugin consumes structured question and permission lifecycle events from
the host:

1. Opening a question writes `question_opened`.
2. Answering, rejecting, or closing it writes `question_closed`.
3. Opening a permission writes `permission_opened`.
4. Approving, rejecting, or closing it writes `permission_closed`.

Only these structured events become pending-input records. The plugin does not
infer requests from ordinary assistant prose.

### Cancelled-draft correction pairs

On `prompt.draft.cancelled`, the plugin writes `draft_cancelled` and retains
the latest pending cancellation for that session in memory.

When a user message arrives:

1. Write its `prompt_submitted` record.
2. Read the pending cancellation for the same session.
3. If it is no more than 10 seconds old, write `draft_corrected` with both
   texts and timestamps.
4. Remove the pending cancellation regardless of whether it matched.

A newer Escape cancellation replaces a previous unmatched cancellation in the
same session. A cancellation with no submission within 10 seconds remains as a
standalone `draft_cancelled` record and is never paired later.

## Tools And Reports

Keep `project_profile_status` focused on preference metrics, while adding a
compact interaction summary:

- Open questions and permissions.
- Submitted-prompt count.
- Cancelled-draft count.
- Correction-pair count.
- Latest interaction timestamps.

Add `project_profile_interactions` to return selected interaction records. It
supports date range, type, pending-only, and a small limit. It returns full
text only on explicit invocation.

Add `project_profile_interactions_forget` to remove one interaction record or
clear the interaction log. `project_profile_forget` continues to delete only
learned preferences and must not delete interaction content.

Global slash-command wrappers may be added separately, but no plugin tool is
automatically a slash command.

## Failure Handling

All interaction capture is fail-open. Errors in event parsing, storage,
retention, matching, or reporting are logged through the plugin's existing
best-effort path and cannot block:

- Clearing a draft with Escape.
- Sending a user message.
- Showing, answering, or approving host requests.
- Existing profile learning or context injection.

Malformed retained records are skipped individually. Interaction data does not
affect preference confidence or injection decisions.

## Testing

Plugin tests cover strict record parsing, 90-day and 1,000-record retention,
per-workspace isolation, fail-open reads and writes, request lifecycle
recording, and correction pairing at the 10-second boundary.

Kilo host tests cover that non-empty Escape clears emit one event, empty Escape
does not emit one, and submitted-turn aborts do not emit draft-cancellation
events. Each affected UI client is tested at its prompt-input event boundary.

## Delivery

Implement in the isolated `feat/interaction-learning` branch. After all plugin
and Kilo checks pass, merge the branch into each repository's `main` branch.
Release the npm package only from the updated standalone-plugin `main` branch
by bumping its version and pushing the matching `v*` tag.
