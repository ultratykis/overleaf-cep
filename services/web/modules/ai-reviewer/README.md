# AI Reviewer module

This private module is the isolated home of the local, project-aware Overleaf
reviewer. Phase 0 provides runtime contracts, a deterministic fake gateway, and
synthetic fixtures. It does not expose an HTTP route, UI, provider connection,
or background scan.

## Feature flag

The module is off by default. It is absent from `moduleImportSequence` unless
the following value is set before the web process starts:

```sh
OVERLEAF_AI_REVIEWER_ENABLED=true
```

Only case-insensitive `true` and `false` are accepted. Empty or unset values
mean false; ambiguous values fail during settings loading.

When disabled, neither this module's entry point nor an enabled shell is
imported by Overleaf. The entry point independently checks the parsed setting
as defense in depth.

## Current layout

- `shared/contracts.mjs`: strict runtime schemas for requests, streamed events,
  findings, evidence, and suggestions.
- `shared/contract-types.ts`: TypeScript types derived from the runtime schemas.
- `app/src/AgentGateway.mjs`: classified gateway errors and the deterministic
  scripted fake.
- `test/fixtures/synthetic/`: manuscript-free LaTeX, bibliography, stale-edit,
  and Zotero-linked fixtures.
- `docs/architecture.md`: host extension map and component boundaries.
- `docs/upstream-sync.md`: upstream patch-stack rehearsal.

## Focused verification

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
  yarn --cwd services/web test:unit:run_dir \
  modules/ai-reviewer/test/unit/src
```

The fake gateway does not read time, randomness, files, network state, or real
project data. Tests control its event sequence and cancellation checkpoints.
