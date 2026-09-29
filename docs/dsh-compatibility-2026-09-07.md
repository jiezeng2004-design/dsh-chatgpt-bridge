# DSH compatibility — 2026-09-07

## Target and provenance

The target is **0.1.3-alpha.1**, the newest prerelease in the
[official GitHub releases](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1),
published 2026-09-04. Its tag resolves to
`d347e703908d0406b7a7ef80e3a0e594d86b2215`.
The official releases and npm version history contain no stable DSH release.
The [official npm registry](https://registry.npmjs.org/@deepseek-ai%2fdsh)
reports `latest` and `next` as **0.1.2-rc.1**, and `alpha` as
**0.1.2-alpha.5**; 0.1.3-alpha.1 is not available there at inspection time.
Do not describe the npm baseline as the newest upstream release.

The development lockfile therefore pins installable 0.1.2-rc.1 packages.
Shared DSH runtime contracts are peers, with explicit rc and alpha ranges, so
an alpha host supplies its own instances instead of receiving duplicate rc
services. Cordis is updated to 4.0.2 and Schemastery to 3.18.2 as required by
the current host dependency graph. The plugin version remains 0.5.1; nothing
was committed or published.

## Local changes

- Replace removed preset resolver with the official preset projection, retaining
  a later preset selection when resuming a cold session.
- Read live sessions through `snapshotEvents()`, including approval command,
  path, execution-fact, and constraint inspection.
- Read alpha persistence through `open(id, 'read')`, `read()`, and `close()` in
  `finally`; normalize `list()` snapshot headers. Retain legacy inspection for
  the npm rc baseline. No write ownership is acquired for inspection.
- Register the current user-question waterfall, clean up aborted requests, and
  delegate requests for unmanaged agents. Managed approval requests retain the
  existing approval policy and delegation behavior.
- Distinguish the current Web gateway from the legacy apiProxy gateway to avoid
  waiting indefinitely for a removed service. Current event handlers precede
  ordinary listeners; unmanaged agent requests continue through DSH.
- Import the todo package's event types explicitly, without mounting its tools.

## Verification and limits

Testing uses separate bridge copies and a disposable DSH_HOME, without reading
real account configuration. Node is 24.18.1 on Windows; Node 22 was not tested.

- npm 0.1.2-rc.1: dependency resolution, TypeScript and server/client builds.
- GitHub 0.1.3-alpha.1: official source archive, frozen pnpm installation, host
  and client builds; bridge compiled against links to those actual source-built
  packages rather than mocks or renamed rc packages.
- Regression suites cover the MCP tool surface, HTTP lifecycle, auth/origin
  checks, session/goal behavior and control runtime. Most host fixtures in these
  tests are synthetic. A separate test uses real Cordis and DSH UserQuestions
  to verify request delivery, answers, cancellation and unmanaged delegation.
  Both dependency graphs completed 390 tests: 389 passed, 0 failed, 1 skipped
  (POSIX token-file permissions on Windows). The final snapshot-only approval
  regression also passed independently on both graphs after its fixture update.
- Alpha CLI `--help` and Web `--help` execute successfully.
- **Default alpha Web startup is blocked:** the native `fs-ext` addon is missing.
  An isolated rebuild fails because node-gyp cannot find a usable Visual Studio
  C++ installation. No global compiler or DSH installation was modified.
- No successful default Web listener, browser UI, real model turn, logged-in
  ChatGPT interaction or tunnel end-to-end result is claimed. UI synchronization
  and competing scoped remote answerers still require live Web acceptance.

This is a local compatibility patch with an explicit runtime acceptance gap,
not a fully verified release. npm availability and successful native Windows
startup must be rechecked before release.

## Rollback

Review and reverse only this run's changes to package.json, package-lock.json,
the bridge/session-view/web-gateway sources, the new persistence helper, their
tests, generated lib files and this compatibility documentation. The original
Git baseline is main at `35072e17439c3e0a2f7dba5d1ff92ea78f816498`.
The pre-existing untracked `docs/openai-codex-oss-application.md` is user-owned
and must remain untouched. No global DSH, real profile or credential rollback
is required.
