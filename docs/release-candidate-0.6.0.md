# v0.6.0 release candidate scope

Status: release candidate; check the exact commit and CI run in GitHub before publication.
Base: remote main at 18cbaf5a6eec508e31a6f6885d59dd91ada46878. The candidate
README preserves that commit's product-first structure and adds compatibility
and source-install guidance. The prior local checkout was based on 35072e1.
Host: exact DSH 0.1.7-rc.2; other prerelease channels are not supported.

## Candidate change allowlist

The following changes, including earlier compatibility edits, form the proposed
release scope. This is not permission to stage other paths. Existing unchanged
tracked files remain part of the normal repository/package; this list records
changed and new candidate files, not the complete npm package contents.

```text
.github/workflows/ci.yml
CHANGELOG.md
README.md
cordis.headless.patch.yml
cordis.patch.yml
docs/dsh-compatibility-2026-09-07.md
docs/dsh-compatibility-2026-09-27.md
docs/dsh-compatibility-2026-09-28.md
docs/release-candidate-0.6.0.md
lib/bridge.js
lib/goal.js
lib/mcp.js
lib/session-persistence-compat.js
lib/status.js
lib/types/bridge.d.ts
lib/types/config.d.ts
lib/types/index.d.ts
lib/types/session-persistence-compat.d.ts
lib/types/status.d.ts
lib/types/version.d.ts
lib/version.js
lib/web-gateway.js
package-lock.json
package.json
pnpm-lock.yaml
scripts/goal-control-dogfood.mjs
scripts/release-package-test.mjs
src/bridge.ts
src/goal.ts
src/mcp.ts
src/session-persistence-compat.ts
src/session-view.ts
src/status.ts
src/version.ts
src/web-gateway.ts
test/integration/dsh-cli.test.mjs
test/integration/dsh-host.test.mjs
test/integration/host-fixture.mjs
test/unit/control-plane-reliability.test.mjs
test/unit/dsh-latest-contracts.test.mjs
test/unit/dsh-questions-integration.test.mjs
test/unit/goal.test.mjs
test/unit/plugin-lifecycle.test.mjs
test/unit/session-persistence-compat.test.mjs
test/unit/status.test.mjs
test/unit/web-gateway.test.mjs
```

## Exclusions

- docs/openai-codex-oss-application.md: unrelated private user document.
- .test-tmp/, node_modules/, logs, tarballs, caches, real profiles and credentials.
- Other plugin projects and global DSH installations.

## Remaining remote gate

Local candidate verification: typecheck and server/client build passed;
399 unit tests (398 passed, 0 failed, 1 Windows platform skip). The installed
tarball gate passed with both official-host integration tests. pnpm frozen
lock and npm manifest/lock version checks passed. These are Windows/Node 24
results, not Linux/Node 22 or remote CI evidence.

Commit only the reviewed allowlist, push the exact candidate, and require every
Ubuntu/Windows x Node 22/24 CI job
to pass, including the installed-tarball gate. An older green HEAD does not
cover this candidate. No tag/npm/GitHub publication before that evidence and
publication authorization. Recheck npm version availability immediately before
publishing. Keep release claims limited to tested layers; UI, real-model,
ChatGPT and tunnel E2E remain unverified.

## Local rollback

Reverse only this candidate's changes after inspecting later edits. Preserve
pre-existing user changes and the .test-tmp/dsh-20260927/baseline snapshot.
Never reset to HEAD or remove all untracked paths to undo this work.
