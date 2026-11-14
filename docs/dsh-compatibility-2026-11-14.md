# DSH compatibility — 2026-11-14 working tree (bridge 0.7.0)

The unpublished working tree targets exactly **DSH 0.2.2-rc.1**, the npm
`latest` tag at verification time. Registry observation on 2026-11-14:
`@deepseek-ai/dsh` `latest=0.2.2-rc.1`, `next=0.2.2-rc.3`,
`alpha=0.2.2-alpha.3`. This is a release candidate, not a stable host.

The package version moves from 0.6.0 to **0.7.0**. The npm-published 0.6.0
targets DSH 0.1.7-rc.2 and the 2026-10-08 working tree targeted 0.2.0-rc.2;
one version number must not name two incompatible hosts. 0.7.0 has not been
published.

## What changed

- Every `@deepseek-ai/dsh-*` peer and development pin moved to exactly
  `0.2.2-rc.1` (each package was confirmed to exist at that version).
  The host requires Cordis `~4.1.0` and Schemastery `~3.19.0`, so the Cordis
  peer is `~4.1.0`, the Cordis dev pin `4.1.0` and the Schemastery dependency
  `3.19.0`. Development dependencies are sorted and each package appears once.
- `package-lock.json` was regenerated from scratch with npm (the previous
  lockfile could not resolve against the new Cordis range). `pnpm-lock.yaml`
  was removed; CI already used `npm ci`.
- `package.json` `files` ships only this document among the dated
  compatibility documents.
- Host API changes handled in `src/bridge.ts`:
  - Model selection is now owned by the Agent (`agent.model`, a durable
    projection). `installModelSelection` takes only the Agent scope and the
    `agent/request` hook is deprecated. The bridge no longer builds its own
    log-derived selection object; it installs the scoped switch-notice
    listener and keeps passing the default route through `agentOptions()`.
    Resume keeps the recorded choice. MCP tool names and semantics are
    unchanged (still 23 tools).
  - The Web app now provides the `webApp` service instead of `webRuntime`.
    `dsh_health` `capabilities.webSurface` checks `webApp` (and still accepts
    `webRuntime`).
- Tests and scripts that hard-coded the old host or bridge version now track
  0.2.2-rc.1 / 0.7.0. The Goal dogfood script reads the bridge version from
  `package.json`. The official-host integration test imports the JSONL
  persistence plugin as a namespace, because `dsh-session-persistence-jsonl`
  no longer has a default export. The latest-contract setup test was rewritten
  for the Agent-owned model selection.
- CI: a step after Build fails when committed `lib/` differs from a fresh
  build (modified, deleted or untracked files). A weekly, non-gating workflow
  (`dsh-next-compat.yml`) installs the `next` host packages without saving and
  runs typecheck, build and the unit suite.

## Verified locally

Windows 11, Node 24.18.1, npm 11.16.0, from a clean `npm install`:

- `npm run typecheck`: exit 0, no diagnostics.
- `npm run build`: exit 0 (`built lib/client.js (38455 bytes)`); committed
  `lib/` is regenerated from `src`.
- `npm run typecheck` now also checks the Web client (`tsconfig.client.json`).
- A rebuild leaves every `lib/` file byte-identical, and every `lib/*.js`
  corresponds to a `src` module.
- `npm test` on the final tree (security hardening, tool annotations,
  `bridge.ts` split, client type checking, portable test paths included):
  `ℹ tests 413`, `ℹ pass 412`, `ℹ fail 0`, `ℹ cancelled 0`, `ℹ skipped 1`
  (one POSIX shell skip on Windows).
- `npm run test:release` on the final tree: both integration tests pass
  against an isolated install of the actual tarball and the exact official CLI:
  `✔ isolated official Web CLI loads bridge, preserves auth/origin and serves MCP tools`,
  `✔ real DSH: explicit setup, V3 read/cold resume, question/approval and teardown`,
  `ℹ pass 2`, `ℹ fail 0`, and
  `PACKED_RELEASE_OK dsh-chatgpt-bridge@0.7.0: 97 files; DSH 0.2.2-rc.1`.
  An earlier attempt failed on the two host changes above, which were then
  fixed; `dsh-session-persistence-jsonl` also lost its default export.
- The flaky parked-approval test was reproduced under CPU load before its
  fix; afterwards the file passed 6 loaded runs and the suite 5 consecutive
  runs.

## Not verified

- No real model, provider credentials, or actual model execution.
- No browser UI interaction; the 2026-10-08 browser acceptance was not
  repeated on 0.2.2-rc.1.
- No ChatGPT connection and no public tunnel.
- No exact-commit CI run (Ubuntu/Windows, Node 24), and the new `lib/` check
  and `dsh-next-compat.yml` have not been run on GitHub. Declaration output
  can reorder union members (seen in `lib/types/index.d.ts`); the `lib/`
  check assumes the pinned TypeScript emits identically on Linux.
- Resume with the Agent-owned model selection was exercised only by the
  model-free cold-resume integration test, not with a real provider.
- `@deepseek-ai/dsh@0.2.2-rc.1` declares `engines.node >=24.9.0` (0.2.0-rc.2
  declared none), so the bridge now requires Node 24.9+ and CI drops Node 22.
  The first PR CI run showed the packed install still worked on Ubuntu /
  Node 22 apart from an EBADENGINE warning, but that is not a supported host.
- Windows CI runners needed more than 10 minutes to install the host graph;
  the packed-install step limit is now 20 minutes.
- `next=0.2.2-rc.3` was not tested; only its Cordis and Schemastery ranges
  were compared (the same as rc.1).
- No real DSH profile or session migration was performed.

Reproduce with `npm run typecheck`, `npm run build`, `npm test`, and
`npm run test:release`.
