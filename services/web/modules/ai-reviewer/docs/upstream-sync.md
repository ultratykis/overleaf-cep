# Upstream synchronization rehearsal

Upstream `ext-ce` may be a rewritten patch stack. Never merge it routinely into
the AI branch and never place AI commits on `ext-ce`.

## Preconditions

```sh
git status --short
git branch --show-current
git remote get-url upstream
git remote get-url --push upstream
git rev-parse refs/vendor/overleaf-cep/accepted
git rev-parse ai-agent
```

Proceed only from a clean `ai-agent` worktree, with the expected fetch URL and
`DISABLED` as the upstream push URL.

## Refresh and preserve refs

```sh
git fetch upstream ext-ce
git branch "ai-agent-before-sync-$(date -u +%Y%m%dT%H%M%SZ)" ai-agent
git update-ref refs/vendor/overleaf-cep/candidate upstream/ext-ce
```

Do not move `refs/vendor/overleaf-cep/accepted` yet.

## Test the candidate base alone

```sh
sync_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
sync_root="../overleaf-cep-upstream-${sync_stamp}"
git worktree add --detach "$sync_root" refs/vendor/overleaf-cep/candidate
```

In the detached worktree, record the registered baseline lint, type, unit,
frontend, acceptance, bundle, and CE image results. Classify pre-existing or
environment failures before replaying AI commits.

## Rebase only the AI patch stack

```sh
old_base="$(git rev-parse refs/vendor/overleaf-cep/accepted)"
old_tip="$(git rev-parse ai-agent)"
sync_branch="ai-agent-sync-$(date -u +%Y%m%dT%H%M%SZ)"
git switch -c "$sync_branch" "$old_tip"
git rebase --onto refs/vendor/overleaf-cep/candidate "$old_base"
new_tip="$(git rev-parse HEAD)"
git range-diff "$old_base..$old_tip" \
  "refs/vendor/overleaf-cep/candidate..$new_tip"
```

Resolve conflicts in host-adapter commits before module-internal commits.
Review every dropped, duplicated, or materially changed patch in the
`range-diff`.

## Gate and accept

Run all evaluations affected by the upstream delta, then the feature-off,
focused AI, production bundle, and server-ce gates. Record evidence against the
candidate base and rebased implementation SHA.

Only after the new base alone, rebased patch stack, range-diff, and independent
verification pass:

```sh
git update-ref refs/vendor/overleaf-cep/accepted \
  refs/vendor/overleaf-cep/candidate
git branch -f ai-agent "$new_tip"
```

No step pushes, publishes, opens a pull request, deploys, or force-pushes a
remote branch.
