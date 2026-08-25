# Contributing to ShotSweep

Thanks for taking the time to contribute! This document covers how to get set
up locally, the shape of the codebase, and what makes a good pull request.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Coding Guidelines](#coding-guidelines)
- [Testing](#testing)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)
- [Adding an Example Config](#adding-an-example-config)
- [Release Process](#release-process)

---

## Code of Conduct

Be respectful, be constructive, assume good faith. Disagreements about
implementation are fine and expected — personal attacks, harassment, or
dismissiveness toward other contributors are not. Maintainers may edit,
close, or lock issues/PRs that don't meet this bar.

---

## Getting Started

### Prerequisites

- **Node.js** — 18 LTS or newer (ShotSweep uses native ESM and top-level
  `fetch`, so an older Node won't work).
- **npm** (or your package manager of choice, adjusted accordingly below).
- A working internet connection the first time you install, since Playwright
  needs to download a Chromium build.

### Setup

```bash
# 1. Fork the repo, then clone your fork
git clone https://github.com/<you>/shotsweep.git
cd shotsweep

# 2. Install dependencies
npm install

# 3. If Playwright's Chromium download failed or was skipped
npx playwright install chromium

# 4. Link the CLI locally so `shotsweep` resolves to your working copy
npm link
```

You should now be able to run `shotsweep capture --url https://example.com`
and have it use your local code.

### Running from source without linking

If you don't want to `npm link` globally, you can invoke the CLI entry point
directly:

```bash
node ./bin/shotsweep.js capture --url https://example.com --dry-run
```

---

## Project Structure

A rough map of `src/`, based on what each module is responsible for:

| File | Responsibility |
| --- | --- |
| `cli.js` | Commander setup — flags, subcommands, and wiring output to the terminal (spinners, `--json`, exit codes). Should stay thin: parse/print, delegate real work to other modules. |
| `capture.js` | Orchestrates a capture run: resolves targets, spins up browser contexts per URL/viewport, handles concurrency, writes `manifest.json`. |
| `inputs.js` | Resolves `--url` / `--urls` / `--csv` / `--sitemap` / `--base`+`--paths` into a flat URL list, plus `--replace-origin` and output-path slugging. |
| `auth.js` | Everything auth-related: `shotsweep login`, building Playwright context options from `--session`/`--bearer`/`--header`, and cookie parsing for `--cookie`. |
| `sections.js` | Viewport-height "sections" capture mode. |
| `diff.js` | `shotsweep diff` — manifest matching + pixel comparison via `pixelmatch`. |
| `describe.js` | Builds the `--describe` AI-ready text summary of a run. |
| `config.js` | Loads `shotsweep.config.json` / `.shotsweeprc.json` and merges it with CLI flags (CLI always wins over config when explicitly passed). |
| `retry.js` | Generic retry helper used for page navigation. |
| `zip.js` | Bundles an output directory into a `.zip`. |

If you're adding a new input source, auth mechanism, or output format, this
table should tell you which file it belongs in. If it doesn't fit cleanly
anywhere, that's worth flagging in your PR description so we can talk about
where it should live.

---

## Development Workflow

1. **Open an issue first for anything non-trivial.** Bug fixes and small
   docs/example fixes can go straight to a PR. New flags, new input sources,
   or behavior changes should start as an issue so we can agree on the shape
   before you write the code.
2. **Branch off `main`.** Use a short, descriptive branch name, e.g.
   `fix/csv-column-detection` or `feat/webp-output`.
3. **Keep commits focused.** Prefer several small, reviewable commits over one
   giant one. Commit messages should explain *why*, not just *what*, when the
   reasoning isn't obvious from the diff.
4. **Update docs alongside code.** If you add or change a flag, update the
   README's options table and, if relevant, add or update an example config
   in `examples/`.

---

## Coding Guidelines

- **ESM only.** Use `import`/`export`, not `require`. All files use
  `.js` with `"type": "module"` semantics.
- **Async/await over raw promises** for anything beyond a one-line `.then()`.
- **Small, single-purpose functions.** Most modules follow a pattern of
  small private helpers (`parseViewport`, `fromCsv`, `keyFor`, etc.) composed
  into one exported entry point (`runCapture`, `resolveTargets`, `runDiff`).
  New code should follow the same shape rather than growing one large function.
- **JSDoc all exported functions.** Every exported function should have a
  JSDoc block with `@param`/`@returns`/`@throws` as applicable — this is a
  library, and the JSDoc is effectively the type contract for consumers who
  aren't reading the source. Non-exported helpers should be documented too
  where their behavior isn't obvious from the name.
- **Errors should be actionable.** Follow the existing style of error
  messages (e.g. `Invalid --concurrency value "${value}". Expected a positive
  integer.`) — say what was wrong and what was expected, not just "invalid
  input."
- **No new dependencies without discussion.** ShotSweep is intentionally
  dependency-light (see the README). If a change needs a new package, explain
  why in the PR/issue before adding it.
- **Formatting.** There's no linter/formatter wired up yet — match the
  existing style in the file you're editing (2-space indent, single quotes,
  semicolons, trailing commas in multiline literals) by eye.

---

## Testing

ShotSweep uses Node's built-in test runner. Run the suite with:

```bash
npm test
```

This runs `node --test test/`, so any new test files should live under
`test/` and use `node:test`/`node:assert` (no extra test framework needed).

For changes that are hard to unit test in isolation (real browser capture,
sitemap fetching, diffing real screenshots), please also do a manual smoke
test and paste the command + output in your PR description, for example:

```bash
shotsweep capture --url https://example.com --dry-run
shotsweep capture --sitemap https://example.com/sitemap.xml --out ./tmp-test --viewport 1440x900
shotsweep diff ./before/manifest.json ./after/manifest.json --out ./tmp-diff
```

If you're adding a new flag or input mode, a `--dry-run` smoke test that
shows the resolved targets is usually enough to demonstrate it works.

---

## Submitting a Pull Request

1. Make sure your branch is up to date with `main` and resolves cleanly.
2. Confirm `npm install` and a basic `capture --dry-run` still work from a
   clean checkout.
3. Update the README / example configs / CHANGELOG if your change affects
   user-facing behavior.
4. Open the PR against `main` with:
   - A short description of **what** changed and **why**.
   - Any relevant issue number (`Closes #123`).
   - The manual smoke-test commands/output if automated tests don't cover it.
5. Be responsive to review comments — small back-and-forth rounds are normal
   and expected.

PRs that only reformat code, rename things stylistically, or otherwise touch
a lot of files without a clear functional purpose are likely to be asked to
narrow scope, since they make it harder to review the actual change.

---

## Reporting Bugs

Open an issue and include:

- The exact command you ran (redact secrets like tokens/cookies).
- What you expected to happen vs. what actually happened.
- Your ShotSweep version (`shotsweep --version`) and Node version (`node -v`).
- Relevant output — with `--debug` enabled if possible, since it surfaces the
  most useful diagnostic detail.
- Your `shotsweep.config.json`/`.shotsweeprc.json` if you're using one, since
  config + CLI flag merging can be a source of "it did something I didn't
  expect."

## Suggesting Features

Open an issue describing the problem you're trying to solve, not just the
flag you want — there may already be a way to do it, or a cleaner design that
solves it more generally. Include a rough example of the command/config
you'd want to write once the feature existed.

---

## Adding an Example Config

The `examples/` directory is meant to show realistic, copy-pasteable setups.
If you add one:

- Use camelCase keys matching the CLI flag names exactly (e.g.
  `replaceOrigin`, not `replace-origin` — config keys are merged against the
  same camelCase option names Commander produces from the CLI flags).
- Keep it focused on one scenario (auth, localhost QA, CI diffing, etc.)
  rather than a kitchen-sink config.
- Name it `<scenario>.config.json` and add a one-line description of when
  you'd use it to the README's config section if one exists.

---

## Release Process

*(Maintainers only.)* Versioning follows semver. Please don't bump the
version in `package.json` yourself — maintainers handle releases and
changelog entries when merging.

---

Questions not covered here? Open an issue — it probably means this doc should
be updated too.