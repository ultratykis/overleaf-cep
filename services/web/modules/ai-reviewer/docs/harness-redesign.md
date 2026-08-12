# AI Reviewer harness redesign

Status: exploration on `ai-reviewer-harness-redesign`, based on
`cfeecb1e1b`. An unrouted prototype now proves the History-to-workspace
boundary; no controller, live History service, runner or deployment path uses
it yet.

## Why this branch exists

The current reviewer combines two different concerns:

1. Overleaf-specific collaboration: editor selection, document identity,
   revision/hash anchoring, findings, comments, suggestion preview and apply.
2. A general-purpose agent harness: provider wire formats, tool loops, project
   file access, context budgeting and retries.

The first concern is the product value. The second overlaps with maintained
agent runtimes such as Codex and Claude Code, and has produced recurring
provider-compatibility and all-or-nothing snapshot failures. The purpose of
this branch is to determine whether the agent runtime can be replaced without
weakening the Overleaf collaboration boundary.

Issue 012 remains open while this comparison is performed. It must not be
silently treated as solved by the redesign investigation.

## Non-negotiable properties

- Results live in the shared Overleaf project, not only in one author's local
  checkout.
- A proposed edit is reviewable before it reaches realtime/OT state.
- Every applicable edit is anchored to captured document identity, revision,
  SHA-256 text hash and UTF-16 range.
- A stale or mismatched edit fails closed.
- Browser-only collaborators can read and act on results.
- Runner credentials, filesystem access and concurrent jobs are isolated per
  user/run according to an explicit policy.
- Provider errors remain bounded. No automatic real-gateway retry loop is
  permitted; real-gateway experiments require user attendance.

## What already exists

The repository already has more of the output side than the previous handoff
assumed:

- `shared/contracts.mjs` defines the strict `SuggestionSchema`.
- `AgentGateway.mjs` rejects project-scope suggestions and checks document id,
  path, revision, text hash, range and original text against the request.
- `single-document-suggestions.ts` repeats the client boundary checks.
- `detached-suggestion-diff.ts` turns one validated suggestion's `original` and
  `replacement` into stable selectable hunks and applies only the chosen hunks.
- `scripts/oss-adoption-diff-probe.mjs` and the OSS adoption fixtures already
  prove guarded, detached diff rendering for insert/delete/replace/adjacent,
  empty-range and multibyte cases.

That existing probe begins after `original` and `replacement` are known. It
does **not** convert an external runner's multi-file patch into Overleaf
suggestions. That conversion is the actual mapping question.

## Candidate runtime boundary

Codex App Server remains a stronger runtime candidate than scraping
`codex exec` output:

- It exposes a bidirectional JSON-RPC interface over stdio, Unix socket or
  WebSocket.
- Threads and turns accept a working directory, sandbox and approval policy.
- It streams `turn/diff/updated` with an aggregated unified diff and
  `fileChange` items with per-path changes.
- The client owns approval UX and can interrupt a turn.

The local environment currently has `codex-cli 0.146.1`; the RDG wrapper is
`codex --profile rdg`. No RDG request has been made in this investigation.
The JSON Schema generated locally by that CLI confirms the
`turn/diff/updated`, `fileChange` and file-change approval surfaces used below.

References:

- <https://developers.openai.com/codex/app-server/>
- <https://github.com/openai/codex/tree/main/codex-rs/app-server>
- <https://github.com/yilewang/llm-for-zotero>

`llm-for-zotero` is useful as a topology example: it reuses the product UI but
treats Codex App Server and Claude Code as separate conversation/runtime
systems. Its desktop-local process model cannot be copied directly into a
multi-user Overleaf server. The reusable idea is the UI/runtime boundary, not
the trust model.

## Mapping boundary

The mapping boundary no longer consumes Git or a runner's unified diff:

```text
revision-pinned Overleaf History snapshot
  -> runner-owned base/ plus agent-writable work/
  -> compare exact base and resulting work text
  -> validated UTF-16 edits
  -> one document-scoped Suggestion
  -> existing detached hunk preview/apply path
```

The manifest must contain at least:

- project id
- document id
- normalized project-relative path
- base revision
- base text hash
- exact original UTF-16 text

The mapper must derive ranges from the captured original text, not trust line
numbers or offsets emitted by a model. After reconstructing the changed text,
it must verify that applying the derived change recreates the runner result.
Git commits, Git Bridge state and `.git` metadata have no role in this proof.

Starting with one document is not only a simplification. The current contract
explicitly forbids suggestions for project scope and permits an edit only in
the requested document/range. Project-wide runner edits therefore require a
new authority model; they are not a parser extension.

## Attended mapping spike (2026-08-07)

The first experiment used an actual Codex result before designing or
implementing a mapper.

### Run

- Source: an independent clone of Git Bridge HEAD `eb72cee` for project
  `ai_debri_chi2027`; the production Git Bridge working tree was not touched.
- Runtime: one ephemeral `codex --profile rdg exec` run with request and stream
  retries overridden to zero.
- Task: make one contiguous wording improvement in the first sentence of
  `sections/01_intro.tex`, changing no other file and running no build/test.
- Result: one file changed, one line replaced. Usage was 44,510 input tokens
  (29,029 cached), 528 output tokens and 201 reasoning tokens.
- No 4xx/5xx provider response was observed. Codex did log one model-catalog
  client decode error: the gateway returned its normal `{"data":[...]}` model
  list while the Codex model manager expected a `models` field. The main
  Responses turn still completed successfully; no retry was made.

The run replaced:

```text
... yet this critical sector is currently grappling with persistent,
structural labor shortages ...
```

with:

```text
... yet the sector faces persistent structural labor shortages ...
```

### Manual mapping

The complete changed sentence can be represented mechanically as a candidate
suggestion:

- project id: `6a39288ab32ec55ba3169b37`
- document id: `6a39288bb32ec55ba3169bc1`
- path: `sections/01_intro.tex`
- Git source commit: `eb72ceec30ae4595330aaff361129553a82e6101`
- Git base text hash:
  `dc896ca012ec5050c3322d135c30c582a61aea3a2a4bb2b2ee7a32ae1d94504c`
- full-sentence UTF-16 range: `58..285`
- original length: 227; replacement length: 194

There is no valid Overleaf `baseRevision` for that candidate. The live document
had already diverged from Git Bridge HEAD:

- live Mongo document version: `549`
- live text hash:
  `9f23c2881dcf3794091152615b5018052e8c6f43c4378e47b21df8e8e3b588c4`
- live first-sentence UTF-16 range: `58..275`
- live sentence uses “while many industries that rely on deskless labor ...”,
  not the sentence edited by Codex

Applying the exact checks in `assertSuggestionForRequest` gives
`identityMatches=false`, `rangeMatches=false` and `originalMatches=false`, so
the correct result is `AI_EVENT_SCOPE_MISMATCH`.

### What the spike established

1. A real Codex edit can be expressed using the existing suggestion fields;
   no production mapper was needed to establish that mechanical feasibility.
2. A Git Bridge checkout is not a revision-pinned representation of the live
   Overleaf document. In this case its last commit was July 23 while the
   Overleaf project was updated afterward.
3. The first architecture problem is therefore project materialization and a
   synchronization barrier, not unified-diff parsing.
4. The existing fail-closed boundary correctly prevents this stale candidate
   from reaching realtime/OT state.

No second gateway run should be made until the runner can start from text that
is cryptographically tied to the exact Overleaf revision captured by the
request.

## Non-Git History workspace proof (2026-08-07)

The next proof uses Overleaf's own project history as the source of truth and
plain directories as the runner boundary.

`ExternalAgentWorkspace.mjs` now proves the following unused production-code
slice:

1. Parse one raw History snapshot with `overleaf-editor-core`'s `Snapshot`.
2. Require a complete `v2DocVersions` mapping from immutable document id to
   historical pathname and document revision.
3. Materialize exact text into runner-owned `base/` and agent-writable `work/`
   directories plus a metadata-only SHA-256 manifest. No `.git` is created.
4. Compare the post-run text with `diff-match-patch`, the same library already
   used by Overleaf's Document Updater and Project History.
5. Emit base-relative UTF-16 edits containing `documentId`, path,
   `baseRevision`, `baseTextHash`, range, original and replacement.
6. Reconstruct the complete post-run text from those edits and reject the
   result unless it matches byte-for-byte at the JavaScript string boundary.
7. Reject non-UTF-8 content, symlinks, additions, removals, renames, excessive
   output, baseline mutation and more than 100 edits.
8. Recheck each candidate against the current Overleaf document and fail with
   `AI_EXTERNAL_WORKSPACE_STALE` after any identity, revision, hash, range or
   original-text change.

The deterministic probe reuses the wording change from the attended Codex
run. It produced one edit at UTF-16 range `87..145`, replacing 58 units with
25, and reconstructed the runner result exactly. Separate insertion, deletion,
multibyte/multi-hunk, stale, unsupported-path and baseline-tamper assertions
also passed.

This establishes the local materialization and mapping mechanics. It does not
yet establish the service checkpoint. The next slice must process pending
History updates, capture the returned global History version, load that exact
version through `HistoryManager.getContentAtVersion`, and bind it to the UI
request before a runner is started. Until then the module remains unrouted and
there is no second gateway call.

## Researched end-to-end proof plan (2026-08-07)

The implementation plan is tracked as deployment issue
`.issues/014-external-harness-single-document-e2e.md`. Repository inspection
resolved four previously open boundaries.

### History is a bounded checkpoint, not a click-time barrier

Project History's `GET /project/:project_id/version` processes the pending
Redis queue under the project history lock and then returns a valid global
History version. `getUpdatesInBatches` stops after the batch that reported no
more entries, so an edit arriving near the end can remain queued for the next
call. The returned version is coherent, but it is not proof that the active
document still equals the UI capture.

The checkpoint must therefore compare the requested document id, path, OT
revision, full-text SHA-256 and selection text with the exact snapshot at the
returned History version. A mismatch gets at most one internal checkpoint
retry and no provider request. A second mismatch fails closed. Resync-pending
checks bracket the snapshot read.

### The first write authority is deliberately one document

The runner may read the complete pinned project, but its accepted output is
limited to the document already authorized by the `AgentRequest`. A selection
request further limits edits to its captured range. Any other changed path
rejects the complete run. This reuses `assertSuggestionForRequest` instead of
weakening it.

Multi-document output remains a separate authority-design problem. It would
need a server-owned contract anchored to the global History version and the
manifest for every writable document; it cannot be introduced by treating a
project-scope request as permission to edit.

### App Server has the required lifecycle controls

The local Codex App Server 0.146.1 schema provides ephemeral threads, explicit
working directories, workspace-write policies with exact writable roots and
network disabled for agent commands, `approvalPolicy: never`, turn completion
notifications and `turn/interrupt`. It also provides stored threads that can be
resumed after an App Server process exits, and stored history can be forked into
a new thread. Process lifetime and conversation lifetime are therefore separate
concerns.

Version 0.146.1 remains historical probe evidence, not the implementation
target. The official npm `latest` tag resolved to stable 0.147.0 on 2026-08-07.
Phase 0 rechecks the latest stable before creating fixtures, then pins that exact
version and artifact integrity for the whole iteration. Docker builds never use
a floating `latest` tag or an alpha release; newer stable releases enter through
an explicit contract-test and rollback cycle.

Every proof process denies approval requests and escalates cancellation from
interrupt to bounded TERM/KILL before deleting its turn directory. Review mode
uses one stdio App Server process per review. Agent mode may reuse one dedicated
process while a user-owned session is active, stop it after an idle TTL, and
resume the stored thread from a new process for the next turn.

The filesystem remains authoritative. App Server diff notifications are
progress signals only; suggestions are derived after completion by comparing
the runner-owned baseline with the work tree.

### Review and Agent are product modes, not process settings

The product must expose two complementary modes over the same History and
Suggestion authority:

| Mode | User contract | Process lifetime | Thread lifetime | Workspace lifetime |
|---|---|---|---|---|
| Review | Produce one bounded review and detached suggestions | one process per review | persisted until user Resolve, then archived/resolved | one turn |
| Agent | Continue writing advice, brainstorming and revisions across turns | reused while active, idle-stoppable | persisted and resumable | rematerialized from current History each turn |

Users choose Review or Agent semantics; they do not configure whether an OS
process is resident. A logical Agent session survives process restarts. A
completed Review can offer “Discuss this review” by forking its stored thread
into a new Agent session, leaving the Review thread immutable. Resuming the same
thread is reserved for continuing an existing Agent session.

History follows the Review Panel comment lifecycle. Records are active until
the user resolves them. Resolve sets `resolved`, `resolved_at` and
`resolved_by_user`, calls App Server `thread/archive`, and moves the item to a
Resolved view. Reopen calls `thread/unarchive` and returns it to active. The
user-facing Agent integration intentionally exposes no hard-delete operation
and cannot call `thread/delete`, even though ordinary comment UI has a separate
delete path. There is no automatic history expiry. A separate site-admin purge
control plane may use `thread/delete` only through a dedicated capability and
the aggregate-only workflow below.

Stored conversation history does not restore process memory, background
processes, a deleted workspace, or edits made by collaborators after the prior
turn. Every Agent turn must acquire a new bounded History checkpoint and use a
turn-owned non-Git workspace. The session records the previous and current
global History versions, document revisions and text hashes. If the pinned App
Server cannot safely rebind a resumed thread to the new workspace, the adapter
must fail closed and use a fork or a bounded Overleaf-owned conversation summary
instead of silently operating on the old snapshot.

### Existing Overleaf stream machinery is sufficient for the proof

The current stream controller already binds browser disconnect and timeout to
an AbortSignal and owns Mongo-backed per-user/global concurrency reservations.
Review and each active Agent turn can use the same NDJSON event contract and
reservations without adding frontend polling. Persistent session metadata is a
separate control-plane record; it does not make a provider turn a durable job.
Completed suggestions continue through the existing workspace, detached
preview and application preflight.

Running the App Server as a child of web is a toolkit-test proof topology, not
a production placement decision. A production adoption must separately approve
a dedicated runner worker/service, credential isolation, egress, version pin,
upgrade and rollback. The external harness remains disabled by default until
that gate is passed.

### Per-user endpoints and API keys are routable, but require process isolation

Codex custom model providers contain a base URL and an `env_key` naming the
environment variable that supplies the API key. The installed 0.146.1 App
Server schema also permits `modelProvider` and a thread-local `config` object on
`thread/start`.

A localhost recording probe created two ephemeral threads in one App Server
process. Each thread received a different custom provider, endpoint, model and
environment-key name, with both provider retry counts set to zero. The actual
requests were routed as configured:

- provider A made `POST /user-a/v1/responses` with A's bearer key;
- provider B made `POST /user-b/v1/responses` with B's bearer key.

This proves routing, not tenant isolation. A shared cross-user process needs
both keys in its environment and is forbidden. Each Review process and each
active Agent-session process contains exactly one decrypted connection owned by
its authenticated user. The isolation key is `userId + sessionId + connection
fingerprint`, rather than only a user id: one user can own multiple endpoints,
and those credentials must not accumulate in a resident process. The existing
provider store already scopes lookup by authenticated user and connection id and
encrypts the credential at rest; the adapter must reuse that boundary rather
than accepting an endpoint or credential in the agent request.

The selected key is exposed to Codex only through one child-process environment
variable referenced by `env_key`. It must not appear in JSON-RPC config, argv,
TOML, the project manifest, stored thread state or logs.
`shell_environment_policy.inherit=none` prevents agent commands from inheriting
it. State homes are created by Overleaf and never inherit server-global account
auth, MCP servers, plugins, memories or another user's threads. Ephemeral Review
homes are not used by the product flow. Review and Agent homes contain only
user/project/session-bound thread state and persist across process exits.
Resolve/archive and Reopen/unarchive change their visible state without
deleting them. There is no per-user session-count or persistent-storage quota,
and no automatic expiry. Process pooling across users or connection
fingerprints is forbidden.

Unlimited product history does not mean ignoring finite storage. The service
records state bytes, free space and growth rate. When a global safety watermark
is crossed it rejects new Reviews/turns with a typed storage error, without
deleting, truncating or silently resolving existing history. Turn-owned
workspaces remain bounded and are deleted after every turn. Orphaned state is
quarantined for operator inspection rather than automatically destroyed.

### Administrator purge is aggregate-only

Permanent deletion is an operator storage-recovery mechanism, not part of the
user conversation lifecycle. It is manual, site-admin-only, and guarded by a
dedicated `ai-reviewer-history-purge` capability. The user-facing controllers
and session APIs have no route to this capability or to App Server
`thread/delete`.

The admin control plane must not expose a list of sessions or a drill-down. Its
allowlisted responses contain only active/resolved counts and bytes, coarse
inactivity buckets, and coarse state-size buckets. They never contain owner,
project, session or thread identifiers, titles, prompts, responses,
suggestions, document paths or text, endpoint or model details. The same
prohibition applies to HTML, audit records, metrics labels and ordinary logs.
Identifiers needed to perform deletion remain internal to the worker.

Every purge requires a dry run. Its ten-minute Express-session plan contains
only criteria, creation time, count, bytes and an opaque nonce; it stores no
matching identifiers. Active state requires the explicit phrase `PURGE ACTIVE`.
Inactivity and size criteria are server-defined coarse presets, not arbitrary
numeric ranges; there is no pagination, search or drill-down. Summary and purge
requests are rate-limited.

Execution re-runs the exact aggregate and returns 409 without deleting anything
if count or bytes changed. It then uses the session store's existing Mongo CAS
boundary to reject anything reopened, updated, claimed by a turn or otherwise
changed. The first implementation intentionally runs at most ten candidates
sequentially under one ten-second abort signal; anything remaining requires a
new dry run. A durable executor is deferred unless a measured ten-item batch
cannot fit the existing HTTP timeout.

Successful live purge claims the record, deletes the App Server thread without
provider credentials, removes the verified session state root, and finally
deletes the Overleaf record. The claim itself writes the `purge_failed` fence so
a crash or partial failure remains visible and retryable without logging target
identifiers. This does not retroactively remove copies from backups; backup
retention and restore implications are disclosed before confirmation.

An Agent session pins its connection id and endpoint/model/provider fingerprint.
Credential-value rotation is picked up when a process starts again. A changed
destination fingerprint is an explicit restart or fork event, not an implicit
mutation of an active session.

Custom providers currently use the Responses wire API. An endpoint accepted by
the current reviewer's broader "OpenAI-compatible" configuration is not
automatically compatible with Codex App Server if it only implements Chat
Completions. Compatibility must be checked per connection before a real run.

Official documentation describes App Server as the deep product-integration
surface, but also marks the current App Server command experimental and not
supported for production workloads. The proof can continue against a pinned
version; a production adoption decision must explicitly compare this risk with
the supported Codex SDK surface and must not follow automatically from a
successful proof.

Official references:

- <https://developers.openai.com/codex/app-server/>
- <https://developers.openai.com/codex/app-server/#start-or-resume-a-thread>
- <https://developers.openai.com/codex/config-advanced/#custom-model-providers>
- <https://developers.openai.com/codex/config-reference/>
- <https://www.npmjs.com/package/@openai/codex>

## Issue 014 toolkit-test outcome (2026-08-08)

This result supersedes the researched fork and web-child proof topology where
they conflict with the approved issue 014 implementation slice.

- The runtime dependency is exactly `@openai/codex` 0.146.0. At the final
  check, npm `latest` 0.147.0 and 0.146.1 were both younger than the repository's
  three-day package-age gate; 0.146.0 was the newest eligible stable release.
  The Yarn checksum is
  `10c0/3e6cf877683904211f66d769d5a25a28eedc17341aaa98718b08097a26eb2c368b282589f5f6a5372659dad8d176db4b6229b784bfe34807b1094dabdacfd9b5`.
  Registry integrity is
  `sha512-yG3sPWNda/2YAIQIDq9MrrjoCTIQ7rxYM5IasrG3VBcuhCLTkgeg/JzqmJq1V98RE4MJ5jCxDXXQlOjrditFRw==`
  for the meta package and
  `sha512-fswvyGprAPCMiOEue/7MKMk7pCjh9kZIJfJX5i9atmfnmGYbYCcUhZsEH9LEP0+0t5xyPqDbfNXY7NSxIVuXxA==`
  for the Linux x86-64 artifact.
- Commits `18c6e62d52`, `59f2377db1`, and `bbaf977047` implement the bounded
  History checkpoint, non-Git workspace, concrete App Server runner, Unix
  socket service, server-owned Mongo session/CAS lifecycle, existing NDJSON
  and Suggestion adapter, and the state-symlink measurement fix.
- `native` remains the default harness. Only toolkit-test selects `external`.
  App Server runs in one dedicated runner container connected to web only by a
  mode-0600 Unix socket. The runner is read-only, uid/gid 33, has no network,
  and alone uses the explicitly approved `seccomp=unconfined` and
  `apparmor=unconfined` settings.
- Review uses one process per run. Agent uses an independent thread seeded from
  the visible Review subject summary; it does not fork or inherit invisible
  Review history. Normal Agent turns reuse the session process. A later turn
  resumes the persisted thread from a new process after a runner restart.
- On image `overleafcep/sharelatex:6.2.0-ai-agent-i014-r2`
  (`sha256:d4f4d4acc7c53f1de8a370eb85f61865bfae341fc79a4eaffb5cc805f57a0f06`),
  two isolated test users concurrently completed Review to detached preview to
  manual Apply. Each then completed two Agent turns with identical process
  IDs, followed by a third turn with new process IDs after runner-only restart
  and the same logical session. Per-user recorder paths and authorization
  hashes never crossed and no recorder request was rejected.
- Owner reads, cross-session 404, cross-project 403, Resolve/archive,
  Reopen/unarchive, stale-revision 409, and final Resolve were observed. The
  user session DELETE route returned 404. Final runner state was two baseline
  processes, zero turn-workspace entries, and zero exact credential matches
  across 891 persistent-state files and all processes.

This is a toolkit-test feasibility result, not a production-adoption decision.
It does not claim Review-to-Agent fork, a Resolved-list UI, disk-watermark
policy, production deployment, or another real-gateway request. The issue 015
outcome below closes the administrator-purge proof; the production runner
decision remains separate.

## Issue 015 toolkit-test outcome (2026-08-08)

- Commits `f06c29078d` and `7e7d88695c` implement credentialless
  `thread/delete`, verified state-root removal, the server-rendered aggregate
  admin page, dedicated capability, fixed buckets, ten-minute dry run, CAS
  execution, bounded synchronous batch, and aggregate-only audit.
- Focused and regression tests passed 75 assertions, with the separate user
  route registration check also passing. Selected ESLint, syntax and Pug
  compilation checks passed.
- Image `overleafcep/sharelatex:6.2.0-ai-agent-i015`
  (`sha256:e7e892a876235ddc77302afa3910300b455ebcd0078372b24e472e412e669d3d`)
  was deployed only to toolkit-test. The dedicated runner remained network
  isolated, read-only and credential-free.
- The admin HTML showed only the expected aggregates and rejected unauthenticated
  and non-admin access. Missing CSRF returned 403, a changed confirmation count
  returned 400 without consuming the plan, and replay of the consumed plan also
  returned 400.
- The fixed `resolved / 90d / any` dry run planned two dedicated fixtures and
  3,721,580 bytes. Confirmation completed in 2.43 seconds with planned, matched
  and deleted values equal; recovered, skipped, failed and remaining were all
  zero.
- The eight non-target records and non-target state had identical before/after
  digests. Exactly two state roots disappeared, workspaces and App Server child
  processes were zero, recorder requests were zero, and the three audit entries
  contained aggregate fields only. Production remained on i007. Image rollback
  does not restore the two purged toolkit-test fixtures.

## Architecture questions after the spike

1. **Runner placement**: isolated server-side job, internal worker service, or
   per-user local bridge. These have different credential and availability
   semantics.
2. **Project materialization**: the local non-Git representation is proven;
   the remaining question is the atomic History checkpoint and request bind.
3. **Concurrency**: how a completed patch becomes stale when collaborators edit
   during a run, and whether partial still-valid hunks may survive.
4. **Multi-document authority**: whether project runs can propose edits to
   several files, and how each file receives an independent captured revision
   and hash.
5. **Approval ownership**: which Codex command/file approvals are handled by a
   worker policy and which must become explicit Overleaf UI actions.
6. **Conversation state**: Review and Agent histories persist without automatic
   expiry or per-user quota. The user-visible lifecycle is active/resolved with
   reversible archive/unarchive and no hard delete. Storage recovery is a
   separate aggregate-only, site-admin purge with mandatory dry-run, race-safe
   batch execution and no per-session disclosure. Remaining work is to set the
   disk watermark/operator alert threshold and to revisit the synchronous batch
   only if a measured ten-item run cannot fit the HTTP timeout, not a
   retention-window decision.
7. **Failure budget**: how the existing circuit breaker wraps runner-level
   retries and provider discovery rather than being bypassed by them.

## Decision gate

Do not choose the replacement architecture merely because single-document
mapping is mechanically possible. Adoption requires an explicit answer for
runner placement,
credentials, concurrency, multi-document authority, lifecycle cleanup,
Review/Agent coexistence, persistent resolved history, storage safety and
the aggregate-only admin purge privacy boundary, plus error-budget enforcement. A
single Review succeeding is not sufficient for adoption: the proof
must also demonstrate an independently seeded Review-to-Agent session and
process-restart resume against a current History checkpoint. If those costs
outweigh removal of the current harness, issue 012 should be fixed with
per-file degradation and the existing harness should be retained with a
narrower provider boundary.

## Production adoption decision (2026-08-08)

Do not adopt the external App Server harness in production while the official
App Server command remains experimental and unsupported for production
workloads. Keep the issue 014/015 implementation and toolkit-test evidence as a
bounded proof, but retain the native reviewer as the production path and fix
issue 012 at its shared project-snapshot boundary.

This decision intentionally defers production runner operations, disk-watermark
policy, a dedicated Resolved-list UI, Review-to-Agent history inheritance, and
multi-document write authority. Re-open the adoption decision only after App
Server has a production-supported contract and the remaining operational work
has a concrete product need.

## Freeze decision (2026-08-12)

The external harness is frozen as future work. The native reviewer remains
the production path. This extends the 2026-08-08 adoption decision with new
first-hand evidence gathered on a local Apple Silicon environment (workspace
issues #101/#102; issue numbers below refer to the workspace tracker).

What was proven before freezing:

- The full pipeline works: web → Unix socket → runner → Codex App Server
  0.146.0 → local OpenAI-compatible endpoint, including multi-turn Agent
  threads and thread resume across a runner container restart (#101).
- A real-browser Review selection run completes end to end and renders the
  model's critique in the panel (#102).
- The edit-collection boundary is sound: a manual work-tree change comes back
  as one anchored edit (documentId, baseRevision, baseTextHash, UTF-16 range).

Why it is frozen rather than adopted:

- `wire_api` is pinned to `"responses"` (#108), so the one production-grade
  connection actually available (an OpenAI-compatible Chat Completions
  gateway) cannot drive it at all.
- Small local models complete turns but never invoke Codex's tools, so the
  edit path cannot be exercised in day-to-day local verification (#113); the
  tools are offered correctly, the models simply cannot ride a 9-tool,
  20KB-instruction agent loop.
- Running Codex's inner bubblewrap sandbox requires relaxing the runner
  container's seccomp profile (#111), an isolation trade-off that deserves
  its own decision before production.
- The runner intentionally reports failures as one opaque error and logs
  nothing (#110), which made every diagnosis in #101/#102 require bypassing
  the socket boundary.
- Checkpointing requires per-document History versions; imported projects
  whose documents were never edited in the editor cannot checkpoint at all
  (#118; the mixed case was fixed as `document-unversioned` exclusions).
- The App Server command remains officially experimental.

Fixes landed during the spike that stand regardless of harness:

- Architecture-aware App Server runtime resolution for linux/arm64.
- A configurable whole-turn timeout, default five minutes.
- Unversioned-document exclusions in external snapshots.
- Consistent frontend import gating for the module.

Conditions for unfreezing, in order: a production-supported App Server
contract upstream; Chat Completions support or a Responses-capable strong
model actually reachable from this deployment (#108); then #110, #111 and
#118 resolved deliberately. Until then no new code lands on the external
path; its tests stay as they are.
