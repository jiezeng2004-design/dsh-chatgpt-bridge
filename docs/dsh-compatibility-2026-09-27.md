# DSH compatibility — 2026-09-27 (unpublished)

> Historical intermediate result. On 2026-09-28 npm `latest` moved to
> `0.1.7-rc.2`; the final checkout targets that version. See
> [the September 28 report](dsh-compatibility-2026-09-28.md). Statements below
> about unsupported newer prereleases describe the September 27 snapshot only.

## Target and authoritative sources

Primary target: **`@deepseek-ai/dsh@0.1.5-rc.3`**, the npm `latest` dist-tag
queried on 2026-09-27. `latest` is a channel name, **not a stable-version claim**.
The registry version list contains no non-prerelease DSH version at this check.

- [Official npm metadata](https://registry.npmjs.org/@deepseek-ai%2fdsh):
  `latest=0.1.5-rc.3`, `next=0.1.7-rc.2`, `alpha=0.1.7-alpha.2`.
- [Official GitHub releases](https://github.com/deepseek-ai/deepseek-harness/releases):
  newest release `dsh-v0.1.7-rc.2`, 2026-09-24, marked prerelease.
  The inspected release list does not contain a `dsh-v0.1.5-rc.3` release entry;
  the installed npm artifacts are authoritative for the exact primary target.
- [0.1.5 release notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1)
  describe V3 sessions, lifecycle-owned SessionHandles, asynchronous agent
  creation, removal of `ctx.agent` and removal of public `Inbox.hasPending`.
- Exact installed `0.1.5-rc.3` declarations and runtime code were checked in
  `dsh-agent`, `dsh-session-persistence`, `dsh-user-approval`, `dsh-user-questions`,
  `dsh-base` and `dsh-web-app`; release notes alone were not treated as proof.

### Newer prerelease assessment

`0.1.7-rc.2` requires Cordis `~4.0.4` and Schemastery `~3.18.4` (different
from the primary graph's `4.0.2` / `3.18.2`). An isolated npm resolution of
the old preset package at `0.1.7-rc.2` fails with ETARGET:
`@deepseek-ai/dsh-agent-presets@0.1.7-rc.2` does not exist. The
[official rc.2 source](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.7-rc.2/packages/preset)
contains `agent-preset` and `agent-preset-registry` instead. This is a separate
preset/provisioning migration, not a version-string bump. This patch does not
advertise support for `0.1.7-rc.2` or `0.1.7-alpha.2`; neither was runtime-tested.
No legacy-peer-deps/force override was used to hide dependency conflicts.

## Changes made in this run

The checkout started dirty at `main`, HEAD
`35072e17439c3e0a2f7dba5d1ff92ea78f816498`. Existing September 7 compatibility
changes and unrelated user documents were preserved, not attributed to this run.

- Pin development packages to `0.1.5-rc.3`; shared runtime imports remain peer
  dependencies. Do not resolve each DSH component using its own `latest` tag:
  component dist-tags differ from the CLI's.
- Use the explicit Agent supplied to `AgentSetup(ctx, agent)` for creation and
  cold-resume model selection. No access to removed `ctx.agent`.
- Read pending state from `inbox.nextTurn` / `inbox.nextStep` rather than removed
  `hasPending`. Use the official `deepseek-flash` fallback model identifier.
- Unwrap V3 `SessionHandle.read()` results (`{ events, eventState }`), validate
  the event array, and always close the read handle. Older read-only adapters
  remain supported by the helper; that does not claim whole-plugin old-host
  compatibility. No session format is parsed or migrated by the bridge.
- Return the official `allowed-once` approval outcome. The previous forced
  cast of `approved` could evade TypeScript and be normalized by the real
  ApprovalService to `unavailable`. Policy decisions were not broadened.
- The headless overlay now inserts only workspace: latest's base bundle already
  owns storage, storage-json, storage-domain and session-projection-cache.
- Add unit and real-host integration regression tests. Keep bearer authentication,
  Web management Host/Origin/custom-header checks and external-vs-owned tunnel
  behavior intact. No tunnel is started by the compatibility tests.

## Verification and limitations

Environment: Windows, PowerShell, Node `24.18.1`. Installations were made in
separate ignored project directories with lifecycle install scripts disabled;
global DSH, real profiles, sessions and credentials were not modified.

- **Static/build:** TypeScript and server/client builds passed against the exact
  official `0.1.5-rc.3` package graph.
- **Regression suite:** final September 27 target run:
  397 tests, 396 passed, 0 failed, 1 skipped (POSIX permissions on Windows).
  The first full run had a Windows approval-wait timeout plus stale fixture
  version/isolated-copy assertions; the final full rerun passed. The timeout
  also passed independently on the original baseline; its business policy was
  not weakened and its timeout was not increased.
- **Real services:** `test/integration/dsh-host.test.mjs` passed with real Cordis,
  AgentLoop, V3 JSONL persistence, UserQuestions and ApprovalService. Covers
  explicit setup, live inspection, human answer, normalized approval audit,
  handle disposal, cold inspection/listing and cold resume, then teardown.
  No model adapter or credentials are mounted; this is not a real-model run.
- **CLI entry:** isolated `dsh --version` reports `0.1.5-rc.3`; `dsh web --help`
  executes successfully. The isolated Web test ultimately passed: MCP bearer
  401, management bad-origin 403, initialize/initialized, 23 tools and health,
  unauthenticated Web 401 and temporary authenticated HTML 200, followed by
  process stop and refusal of both listening ports. Early connection resets
  came from probing before official readiness in an incomplete test profile;
  enabling only its empty temporary credential store and waiting for the
  Loader-ready announcement fixed the test without changing bridge auth.
- **UI/real workflow:** no browser interaction, logged-in ChatGPT, real model,
  production connection or external/owned tunnel E2E is claimed. No remote CI,
  Linux or Node 22 run was performed in this update.

Reproduce the ordinary local gates with `npm ci`, `npm run typecheck`,
`npm run build`, `npm test`. For host integration, use a **disposable copy**
containing package.json, lib, test and the normal dependencies, install exact
`@deepseek-ai/dsh@0.1.5-rc.3` there with `--ignore-scripts`, and run
`node --test test/integration/*.test.mjs`. Never run installation commands
against a real user profile for this test. Integration tests create and remove
only their own temporary homes and synthetic sessions.

## Rollback

This run's pre-edit code snapshot is in the ignored local directory
`.test-tmp/dsh-20260927/baseline/`. It includes the already-dirty source,
generated files, manifests/lockfiles, tests, overlays and README. Compare and
reverse only this run's changes; do not reset to HEAD (that would discard the
earlier compatibility work). New September 27 report/integration/contract test
files can be removed only if still owned solely by this run. The original
`docs/dsh-compatibility-2026-09-07.md` and user document remain untouched.
No global install, real-session migration, credentials or network rollback is
needed. Nothing was committed, pushed, packaged for publication or released.
