# @pocs/pause-harness

The pause checks shared by [`../microsandbox-pause`](../microsandbox-pause/README.md) and
[`../gvisor-pause`](../gvisor-pause/README.md): the stub, the success criteria of
[poc-e2b-pause](../../docs/plans/poc-e2b-pause.md), and the report format. A backend implements
`start`, `pause`, `resume`, `hostUsage` and `egress` ([`src/index.mts`](src/index.mts)); `main` runs the
`run`, `pause`, `resume` and `egress` commands against it.

[`src/stub.mjs`](src/stub.mjs) is a copy of the E2B POC's stub, unchanged. The E2B POC keeps its own
host script; moving it onto this harness only makes sense once a backend is chosen.

The point beyond these POCs: if the engine supports more than one sandbox backend (see the design
discussion on using different ones per OS), every backend has to pass the same checks. This is the
start of that suite.
