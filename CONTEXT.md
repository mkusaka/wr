# Domain Context

## Ubiquitous Language

### Task

- Definition: A globally shared unit of work identified by its external issue ID.
- Lifecycle: `open` -> `active` -> `done` or `cancelled`; a finished task may be started again.

### PullRequest

- Definition: A globally shared GitHub pull request related to zero or more Tasks.
- Lifecycle: `open` -> `closed` or `merged`, synchronized from GitHub metadata supplied by the CLI.

### Device

- Definition: A computer used by one Cloudflare Access user. Its stable identity is a locally generated UUID bound to that user by the Worker.
- Lifecycle: Created on its first authenticated request and used to isolate all machine-local records.

### CliSession

- Definition: A Codex or Claude session owned by one Device.
- Identity: Unique within a Device by CLI kind and external session ID.

### SessionRun

- Definition: One local terminal run of a CliSession, owned by the same Device.

### Checkout

- Definition: A Git repository checkout discovered by the CLI, owned by one Device.

### Execution

- Definition: Work performed for one Task in a CliSession and optionally a Checkout; attributed to the session's Device.

### WorkpadLink

- Definition: A reference created by a Device and attached to a Checkout and optionally a Task.

## Invariants

- Tasks and PullRequests are shared across Devices.
- CliSessions, SessionRuns, Checkouts, Executions, and WorkpadLinks are visible and mutable only by their authenticated Access user.
- A Device ID is accepted from the CLI only after the Worker binds it to the authenticated Access user.
- Git and iTerm2 inspection happen on the CLI; durable relationship data is read and written only through the Worker API.
