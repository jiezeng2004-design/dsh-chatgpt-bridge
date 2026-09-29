# DSH latest compatibility — 2026-09-28 (prepublication verification snapshot)

## Final target

**`@deepseek-ai/dsh@0.1.7-rc.2`** is the final target. The official npm registry
initially reported `latest=next=0.1.7-rc.2` on September 28. At release
preflight, `latest` remains `0.1.7-rc.2`, while `next` is `0.2.0-rc.1` and
`alpha` is `0.1.7-alpha.2`. This is a **release candidate**, not a stable release.
The task originally verified September 27's `latest=0.1.5-rc.3`; the tag moved
before handoff, so that result was preserved as historical evidence and the
new latest was adapted and tested independently.

Sources:

- [Official npm metadata](https://registry.npmjs.org/@deepseek-ai%2fdsh).
- [Official rc.2 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2),
  published 2026-09-24 and marked prerelease.
- [Official preset registry source](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.7-rc.2/packages/preset/agent-preset-registry)
  and the exact published npm package declarations/runtime implementations.
- [Session/Inbox/Agent changes introduced in 0.1.5](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1).

Development and shared DSH peer versions are pinned to **`0.1.7-rc.2`**, matching
the new host's exact-version contract. Cordis is `4.0.4` (peer `~4.0.4`) and
Schemastery `3.18.4`. The removed `dsh-agent-presets` package is replaced by
`dsh-agent-preset-registry`. Component-specific dist-tags are not interchangeable
with the CLI's `latest`. No compatibility with `0.1.7-alpha.2` or other host
versions is claimed for the final manifest.

## Implemented changes

- Use the explicit Agent in `AgentSetup(ctx, agent)` for creation/resume model
  selection; no removed `ctx.agent` access. Default fallback is `deepseek-flash`.
- Import the preset projection from the new registry package. Continue using
  its official resolve/mount APIs and replay the last durable preset selection
  before cold resume; do not reimplement preset composition or migration.
- Unwrap V3 `SessionHandle.read()`'s `{ events, eventState }`, check that events
  are an array, and close read handles on both success and failure. Inspection
  never acquires a writer. Existing read-only legacy adapters remain in the
  helper, but do not imply support for old whole-host dependency graphs.
- Derive queued state from public Inbox lists, not removed `hasPending`.
- Handle the new `forked` turn-end reason as a distinct terminal wait outcome,
  not successful task completion. Later queued/running work still takes priority.
  Update the MCP status description and Goal terminal-state handling together.
- Return official `allowed-once` approval outcomes instead of an invalid
  `approved` value hidden by a cast. Existing approval policy remains unchanged.
- Remove duplicate storage/cache inserts from the headless overlay: those rows
  are already owned by the new base bundle. Only workspace is added for a
  base-backed non-Web profile.
- Update both lockfiles, generated server/declaration artifacts, source-install
  instructions, and unit/real-host integration tests. Plugin package version
  is now `0.6.0`; this is an unpublished release candidate.

Authentication and lifecycle boundaries remain unchanged: MCP uses bearer
authentication; Web management mutations retain loopback, Host, Origin, content
type and custom-header checks. An external reachable tunnel is not described as
a plugin-owned started tunnel. No real tunnel was started or changed.

## Verification

Windows, PowerShell, Node **24.18.1**. Separate clean dependency and full-host
directories were used under `.test-tmp/dsh-20260928/`. Install lifecycle scripts
were disabled; this is not evidence that every optional install script ran.
The existing checkout's node_modules and global DSH installation were left
untouched. Use the updated lockfile with `npm ci` when choosing to rebuild this
checkout; the recorded gates ran on copies of its final sources and tests.

- **Static/build:** exact `0.1.7-rc.2` dependency graph passes TypeScript and
  server/client builds.
- **Unit/local regression:** 398 tests, 397 passed, 0 failed, 1 skipped
  (POSIX 0600 permissions on Windows); full run completed in 39.3 seconds.
  Includes MCP schema/tool count, bearer auth, management Origin/Host guards,
  owned/external tunnel state, session/goal behavior and plugin lifecycle. Most
  fixtures are synthetic; HTTP tests really bind temporary loopback listeners.
- **Real-host integration:** both tests passed (2/2, 0 failures), including
  exact installed DSH version and preset/Web/question capability health checks.
- **Real DSH services:** `test/integration/dsh-host.test.mjs` uses official
  Cordis, AgentLoop, V3 JSONL, UserQuestions and ApprovalService. Verifies explicit
  setup, question answer, allowed-once audit, read-handle cleanup, cold listing,
  read/resume and service teardown. No model adapter is mounted.
- **Actual CLI/Web/MCP:** `test/integration/dsh-cli.test.mjs` runs official CLI
  with a fresh temporary home/cwd, an environment allowlist, telemetry disabled,
  real-model adapters disabled and a synthetic empty preset/workspace. Waits
  for the official Loader-ready announcement, not just a listening port.
  Verifies bearer 401, management bad-origin 403, initialize/initialized,
  23 MCP tools, health, session create/get/title with the real new preset registry,
  Web unauthenticated 401 and temporary authenticated HTML 200. Stops only its
  owned child and checks that both test endpoints no longer accept connections.
  The temporary browser-auth record/cookie is generated for this test only and
  is not logged or copied from any user credential store.
- **Not verified:** rendered browser UI/settings interaction, actual model turn
  or filesystem tool execution, logged-in ChatGPT workflow, external/owned
  tunnel E2E, production, remote CI, Linux and Node 22. HTML 200 is not UI proof;
  model-free contract tests are not a real-model workflow.

Reproduce ordinary gates: `npm ci`, `npm run typecheck`, `npm run build`,
`npm test`. For real-host tests, use a **disposable copy** of the project and
its dependencies; install `@deepseek-ai/dsh@0.1.7-rc.2` there with
`--ignore-scripts`, then run `node --test test/integration/*.test.mjs`. Do not
install into a real profile for verification. Tests delete only the temporary
homes and synthetic sessions they create, and never reuse existing browser data.

## v0.6.0 release preparation

- Version is synchronized across the manifest, npm lock root, runtime health
  constant, generated declarations and Goal dogfood expectations. The pnpm
  lock has no root package version field; frozen-lock verification passed.
- README duplicate maintenance sections were removed. Published v0.5.1
  installation remains explicitly historical; candidate source instructions
  do not claim that this version is available from npm or a release tag.
- `npm run test:release` packs the real candidate, validates its file list,
  installs that tarball plus exact official DSH in a new temporary directory,
  and runs both real-host tests against installed `lib`, not checkout `lib`.
  It verifies the bridge health version against the installed manifest.
- The packed v0.6.0 test passed on Windows/Node 24: 87 packed files, 602
  installed packages, both host tests passed. Install scripts were disabled;
  no real profile, credentials or model calls were used. Only the test-owned
  temporary installation was deleted after exit.
- CI now includes this gate in each Windows/Linux and Node 22/24 matrix job.
  Check the exact candidate commit's remote CI separately before publication.
- A regression assertion guards the release entry point and CI coverage.
  The final local unit run had 399 tests: 398 passed, 0 failed, 1 Windows
  platform skip. The preceding 398-test result documents the earlier baseline.
- Release file scope is listed in `docs/release-candidate-0.6.0.md`.
  Publication state must be verified from npm and GitHub independently.

## Preserved work and rollback

Initial branch/HEAD: `main` at
`35072e17439c3e0a2f7dba5d1ff92ea78f816498`, with existing dirty compatibility
work. No repository AGENTS.md was found; the supplied working agreement applied.
The original September 7 report and unrelated user document were not changed.
Earlier modified web-gateway/session-view sources were preserved.

- Pre-task snapshot: `.test-tmp/dsh-20260927/baseline/` (already-dirty source,
  manifests, lockfiles, tests, generated files, overlays and README).
- Additional September 27 verified source snapshot:
  `.test-tmp/dsh-20260928/rc5-complete/`.
- Compare and reverse only this task's differences. Do not reset to HEAD or
  remove all untracked files: that would discard pre-existing work. Remove new
  report/test files only if no later user work depends on them.
- No global DSH, real profile/session migration, credential, network or other
  plugin rollback is required. Local validation did not include a tag,
  GitHub Release, npm publication or deployment.
