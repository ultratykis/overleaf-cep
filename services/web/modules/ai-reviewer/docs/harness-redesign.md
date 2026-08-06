# AI Reviewer harness redesign

Status: exploration on `ai-reviewer-harness-redesign`, based on
`cfeecb1e1b`. This document records the decision boundary before production
code is changed.

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

Codex App Server is a stronger first candidate than scraping `codex exec`
output:

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

The first spike stays deliberately narrower than a project-wide agent:

```text
captured Overleaf document state
  -> isolated file plus identity manifest
  -> runner fileChange/unified-diff event
  -> validated changed text
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

## Architecture questions after the spike

1. **Runner placement**: isolated server-side job, internal worker service, or
   per-user local bridge. These have different credential and availability
   semantics.
2. **Project materialization**: git-bridge checkout versus a revision-pinned
   export generated by Overleaf. Git alone does not identify unsynced live
   editor state.
3. **Concurrency**: how a completed patch becomes stale when collaborators edit
   during a run, and whether partial still-valid hunks may survive.
4. **Multi-document authority**: whether project runs can propose edits to
   several files, and how each file receives an independent captured revision
   and hash.
5. **Approval ownership**: which Codex command/file approvals are handled by a
   worker policy and which must become explicit Overleaf UI actions.
6. **Conversation ownership**: whether runner threads are ephemeral per review
   or resumable per Overleaf workspace, and how their stored state is deleted.
7. **Failure budget**: how the existing circuit breaker wraps runner-level
   retries and provider discovery rather than being bypassed by them.

## Decision gate

Do not choose the replacement architecture merely because single-document
mapping is mechanically possible. Adoption requires an explicit answer for
runner placement,
credentials, concurrency, multi-document authority, lifecycle cleanup and
error-budget enforcement. If those costs outweigh removal of the current
harness, issue 012 should be fixed with per-file degradation and the existing
harness should be retained with a narrower provider boundary.
