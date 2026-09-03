# Tests

These are compiled-JS integration tests, not a test framework (no Jest/Mocha) — each
`test_*.js` / `e2e_*.js` file is a self-contained Node script that:

- Redirects `require("vscode")` to `fake-vscode.js` (a minimal stub of the VS Code API —
  `window`, `commands`, `workspace`, `Uri`, etc.) via a `Module._resolveFilename` hook.
- Requires the real **compiled** extension code from `../out/` and exercises it directly
  (`GitHelper`, `promoteStory`, `DeploymentEngine`, the webview providers, ...) with mocked
  or real git/CLI calls, depending on the test.
- Prints `PASS`/`FAIL` per assertion and exits non-zero if anything failed.

## Running

```sh
npm test
```

This runs `npm run compile` first (tests run against `out/`, not `src/`), then executes
every test file via `test/run.js` and prints a summary.

To run a single file directly (useful while iterating):

```sh
npm run compile
node test/test_deploy_error.js
```

## Real-repo tests

A handful of files (anything that touches real git history/branches rather than just
mocked objects — `e2e_*.js` and a few `test_*.js`) run against an **actual** Salesforce DX
git repo, not fakes, to catch real git-plumbing bugs the mocked tests can't. They need:

```sh
export SF_DEVOPS_TEST_REPO=/path/to/a/real/salesforce/dx/repo
```

Without it, they fall back to a specific developer machine's path and, if that doesn't
exist either, **skip themselves cleanly** (`SKIP`, exit 0 — not a failure) rather than
crashing. `npm test` will report them as skipped; that's expected on a machine without
that repo checked out.

The real repo these were originally written against expects: a `dev`/`qa`/`uat` branch
layout, at least one feature branch with real history (`feature/TEST3` in the original
data), and `main` as the base branch. If you want full real-repo coverage on a new
machine, point `SF_DEVOPS_TEST_REPO` at a repo shaped similarly, or treat the skips as
acceptable — the 36 mocked tests already cover the same logic paths without needing one.

## Adding a new test

Copy the shape of an existing `test_*.js` file: the `Module._resolveFilename` shim at the
top, mock whatever `GitHelper`/`config`/`vscode` surface the code under test touches, call
into `../out/...`, assert with `check(name, condition, extraInfoOnFailure)`, and end with
`process.exit(allPass ? 0 : 1)`. No registration needed — `test/run.js` picks up any
`test_*.js`/`e2e_*.js` file automatically.
