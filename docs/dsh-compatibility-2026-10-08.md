# DSH compatibility — 2026-10-08 working tree

The unpublished working tree targets exactly **DSH 0.2.0-rc.2**. Registry
verification returned `latest=next=0.2.0-rc.2`, `alpha=0.2.1-alpha.1`.
This is a release candidate, not a stable host. The existing published 0.6.0
package still targets 0.1.7-rc.2; its version has not been bumped or republished.

Verified locally on Windows, Node 24.18.1:

- TypeScript typecheck and server/client build pass.
- Source suite after composing with merged PR #9: 401 tests, 400 passed,
  zero failed, one POSIX shell skip.
- `npm run test:release` installs the actual tarball and exact official CLI
  into a disposable root: both integration tests pass; the package contains
  88 files and installs against exactly DSH 0.2.0-rc.2.
- Cold session resume, explicit setup, questions/approvals and teardown work.
- Official Web CLI boots; authentication and origin policy remain enforced;
  authenticated MCP exposes 23 tools and creates/reads sessions. Root HTTP
  succeeds. The owned child is stopped and its listener closes.
- Earlier same-day browser acceptance verified the actual official Web
  application's Chromium settings navigation,
  dirty proxy edits surviving polling, save HTTP 200, reload persistence and
  restoration of the original proxy value. Page and console errors are zero.
  Auto-start stayed disabled and no tunnel start request was sent.

The final local submission review combined these changes with main at
`e3557f12bad19c7e7ea97dca7a3344f1e19c9534` (merged PR #9). Clean npm
installation, pnpm frozen-lockfile validation, typecheck/build, the full unit
suite and installed-tarball integration passed on that combined source.
Browser settings interaction was not repeated in this submission review.

Browser acceptance exposed an existing save failure: the form submits an
empty Tunnel ID before setup or on clear, while the route rejected it as an
invalid identifier. The route now accepts this explicit unconfigured state
and still rejects malformed nonempty IDs. The regression checks the full
settings body, including disabled auto-start and proxy options.

One full-suite run timed out waiting for a parked approval; that test file
passed in isolation (13/13), then the full suite passed sequentially (399 +
one skip). The earlier timeout is retained as a test-timing limitation, not
silently counted as a passing run.

These tests use synthetic sessions and an isolated profile. They do not prove
actual model execution, ChatGPT connectivity, public tunnel operation or an
exact-commit CI run. No real profile, credential
or session migration was performed. Publication requires an explicit version
decision and exact-commit CI verification.

Reproduce with `npm run typecheck`, `npm run build`, `npm test`, and
`npm run test:release`. The packed test checks its disposable cleanup boundary.
