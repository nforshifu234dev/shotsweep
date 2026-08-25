<h1 align="center">📸 NFSFU234ShotSweep</h1>

<p align="center">
  <strong>Visual regression testing from the command line.</strong>
</p>

<p align="center">
  Capture your site, compare it before and after a change, and let CI tell you when something actually looks different.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nfsfu234/shotsweep">
    <img src="https://img.shields.io/npm/v/%40nfsfu234%2Fshotsweep?style=for-the-badge" alt="NPM Version">
  </a>
  <a href="https://github.com/nforshifu234dev/shotsweep/blob/main/LICENSE">
    <img src="https://img.shields.io/npm/l/%40nfsfu234%2Fshotsweep?style=for-the-badge" alt="License">
  </a>
  <img src="https://img.shields.io/github/last-commit/nforshifu234dev/shotsweep?style=for-the-badge" alt="Last Commit">
  <img src="https://img.shields.io/github/stars/nforshifu234dev/shotsweep?style=for-the-badge" alt="GitHub Stars">
</p>

<p align="center">
  Built by <a href="https://iamnotshifu.com">IAMNOTSHIFU</a>,
  through <a href="https://nforshifu234dev.com">NFORSHIFU234 Dev</a> 🇳🇬
</p>

---

## Why ShotSweep?

A website can pass every conventional test and still look broken.

Your build can pass.

Your unit tests can pass.

Your API tests can pass.

Your application can return HTTP 200.

And a CSS change can still move a button, break a layout, hide content, or completely change how a page looks.

That is the problem ShotSweep is designed to catch.

ShotSweep captures real pages with a real browser and gives you a repeatable way to compare those pages between runs.

```text
Application
     │
     ▼
  ShotSweep
     │
     ├── Capture pages
     ├── Capture authenticated pages
     ├── Capture multiple viewports
     ├── Save a manifest
     │
     ▼
  Deploy / Change
     │
     ▼
  ShotSweep diff
     │
     ├── unchanged → pass
     ├── changed   → fail
     └── report    → review
````

It is intentionally a CLI rather than a hosted dashboard.

Your screenshots, manifests, and diffs stay in your project or CI artifacts.

---

# 🚀 What ShotSweep does

ShotSweep can:

* 📸 Capture a single URL
* 🗺️ Capture every URL in a sitemap
* 📄 Read URLs from JSON, TXT, or CSV files
* 🏠 Capture local development sites
* 🔀 Reuse production sitemaps against localhost or staging
* 🖥️ Capture multiple viewport sizes
* 📐 Capture full pages or viewport-height sections
* 🔐 Capture authenticated pages
* 🔑 Reuse login sessions
* 🆚 Compare two capture runs
* 📊 Produce machine-readable diff results
* 🤖 Produce AI-ready run summaries
* ⏸️ Resume large capture runs
* 📦 Package results into ZIP archives
* ⚙️ Run naturally inside CI/CD
* 🪶 Keep the implementation dependency-light

The goal is simple:

> **Capture what the site looked like. Compare it later. Know what changed.**

---

# 📦 Installation

```bash
npm install -g @nfsfu234/shotsweep
```

ShotSweep uses Playwright and automatically installs Chromium during installation.

### If npm blocks the install script

Some npm configurations block package lifecycle scripts until they are explicitly approved.

If you see:

```text
npm warn install-scripts 1 package had install scripts blocked
npm warn install-scripts @nfsfu234/shotsweep@0.1.0
```

Approve the installation script:

```bash
npm install-scripts approve @nfsfu234/shotsweep
```

Then install again:

```bash
npm install -g @nfsfu234/shotsweep
```

### Installing Chromium manually

If you prefer not to allow package install scripts, install Chromium manually:

```bash
npx playwright install chromium
```

Then verify the installation:

```bash
shotsweep --help
```

You should see:

```text
capture
login
diff
```

---

# ⚡ Quick Start

## Capture one page

```bash
shotsweep capture \
  --url https://example.com \
  --mode full
```

## Capture an entire sitemap

```bash
shotsweep capture \
  --sitemap https://example.com/sitemap.xml \
  --out ./screenshots
```

## Capture multiple viewports

```bash
shotsweep capture \
  --sitemap https://example.com/sitemap.xml \
  --viewport 1440x900 \
  --viewport 390x844 \
  --out ./screenshots
```

## Capture a local application

```bash
shotsweep capture \
  --base http://localhost:3000 \
  --paths paths.json \
  --viewport 1440x900
```

## Preview what would be captured

```bash
shotsweep capture \
  --sitemap https://example.com/sitemap.xml \
  --dry-run
```

---

# 🔀 Input Modes

ShotSweep accepts several ways to define what should be captured.

| Input                         | Description                                 |
| ----------------------------- | ------------------------------------------- |
| `--url <url>`                 | Capture one URL                             |
| `--urls <file>`               | JSON array or newline-delimited `.txt` file |
| `--csv <file>`                | Read URLs from a CSV                        |
| `--sitemap <url>`             | Capture URLs from a sitemap                 |
| `--base <url> --paths <file>` | Combine a base URL with relative paths      |

### Sitemap support

ShotSweep understands both normal sitemaps and sitemap indexes.

```bash
shotsweep capture \
  --sitemap https://example.com/sitemap.xml
```

This makes it possible to turn an existing site's URL structure into a visual test target without manually maintaining hundreds of URLs.

---

# 🔀 Reuse a Production Sitemap Locally

One of the useful parts of sitemap-based capture is that your production sitemap can become your staging or local test plan.

For example:

```bash
shotsweep capture \
  --sitemap https://example.com/sitemap.xml \
  --replace-origin http://localhost:3000
```

A URL such as:

```text
https://example.com/products
```

becomes:

```text
http://localhost:3000/products
```

You can therefore use the same sitemap across:

* production
* staging
* preview deployments
* localhost

without maintaining separate URL lists.

---

# 📸 Capture Modes

## Full-page capture

```bash
shotsweep capture \
  --url https://example.com \
  --mode full
```

Produces a complete page screenshot.

## Sectioned capture

```bash
shotsweep capture \
  --url https://example.com \
  --mode sections
```

Section mode divides a page into viewport-height screenshots.

This is useful for:

* long documentation pages
* marketing pages
* large dashboards
* pages where individual sections are easier to review
* CI artifacts where a giant full-page image is inconvenient

---

# 🖥️ Viewports

ShotSweep supports repeatable viewport arguments:

```bash
shotsweep capture \
  --url https://example.com \
  --viewport 1440x900 \
  --viewport 1024x768 \
  --viewport 390x844
```

There are also presets:

```bash
--viewport desktop
--viewport tablet
--viewport mobile
```

This allows one capture run to represent several important viewing environments.

---

# 🌙 Dark Mode

Capture pages with the browser's dark color scheme enabled:

```bash
shotsweep capture \
  --url https://example.com \
  --dark
```

ShotSweep uses the browser's `prefers-color-scheme: dark` emulation.

---

# ⏱️ Waiting for Pages

Dynamic applications often need time to finish rendering.

ShotSweep supports both fixed waits and selector-based waits:

```bash
shotsweep capture \
  --url https://example.com \
  --wait 3000
```

Or:

```bash
shotsweep capture \
  --url https://example.com \
  --wait "#app-ready"
```

You can also control the browser load condition:

```bash
shotsweep capture \
  --url https://example.com \
  --wait-until networkidle
```

The default is:

```text
load
```

This avoids making every page wait forever because of a persistent connection, analytics request, WebSocket, or other long-lived network activity.

---

# 🆚 Visual Regression

The core workflow is:

```text
capture
   ↓
make a change
   ↓
capture again
   ↓
diff
   ↓
review / CI
```

For example:

```bash
shotsweep capture \
  --sitemap https://example.com/sitemap.xml \
  --out ./before
```

Make your application change.

Then:

```bash
shotsweep capture \
  --sitemap https://example.com/sitemap.xml \
  --out ./after
```

Compare the runs:

```bash
shotsweep diff \
  ./before/manifest.json \
  ./after/manifest.json \
  --out ./diff
```

For changed screenshots, ShotSweep produces:

```text
diff/
├── ...
├── old.png
├── new.png
├── diff.png
└── diff-report.json
```

The report contains the machine-readable result of the comparison.

---

# 🎯 Why pixel comparison?

ShotSweep intentionally uses direct pixel comparison.

It does not attempt to decide that two images are "close enough" using an ML model.

That makes the behavior predictable:

```text
same pixels
    ↓
unchanged

different pixels
    ↓
changed
```

A threshold can then be used to decide how much pixel difference is acceptable for a run.

This is particularly useful in CI, where you want a deterministic result rather than a model making a subjective visual decision.

---

# 🎚️ Thresholds

`--threshold` controls how much of the image may differ before ShotSweep reports a page as changed.

### Raw ratio

```bash
--threshold 0.001
```

This means:

```text
0.001 = 0.1%
```

### Percentage

```bash
--threshold "0.1%"
```

### Presets

```bash
--threshold strict
--threshold default
--threshold loose
```

Current presets:

| Preset    | Value   | Intended use                             |
| --------- | ------- | ---------------------------------------- |
| `strict`  | `0.01%` | Near pixel-perfect comparisons           |
| `default` | `0.1%`  | General visual regression                |
| `loose`   | `1%`    | More tolerance for rendering differences |

For example:

```bash
shotsweep diff \
  before/manifest.json \
  after/manifest.json \
  --threshold "0.5%"
```

If your CI environment introduces small rendering differences, a looser threshold may be appropriate.

If you are testing a highly controlled environment or a design system where tiny changes matter, a stricter threshold may be better.

---

# 🚦 CI Regression Policy

By default, ShotSweep treats visual changes as a CI failure.

| Result         | CI               |
| -------------- | ---------------- |
| `changed`      | ❌ Fail           |
| `size-changed` | ❌ Fail           |
| `unchanged`    | ✅ Pass           |
| `added`        | ✅ Pass, reported |
| `removed`      | ✅ Pass, reported |

This makes `shotsweep diff` usable as a pipeline gate.

For example:

```bash
shotsweep diff \
  ./before/manifest.json \
  ./after/manifest.json
```

If a real visual regression is detected, the process exits non-zero.

That means your CI system can treat the command like any other test:

```text
tests
  ↓
build
  ↓
visual capture
  ↓
visual diff
  ↓
PASS / FAIL
```

---

# 🤖 Machine-readable CI Output

Use:

```bash
--json
```

for machine-readable output.

You can also create a human-readable report:

```bash
shotsweep diff \
  ./before/manifest.json \
  ./after/manifest.json \
  --summary \
  --text ./diff/summary.txt
```

This makes it possible to keep both:

* structured CI output
* human-readable artifacts

---

# 🔐 Authentication

Visual regression is much more useful when it can test pages that are not public.

ShotSweep supports:

* form login
* saved browser sessions
* bearer tokens
* custom headers
* cookies

## Form login

```bash
shotsweep login \
  --login-url https://example.com/login \
  --email-selector "#email" \
  --password-selector "#password" \
  --submit-selector "button[type=submit]" \
  --email you@example.com \
  --password $APP_PASSWORD \
  --session-out auth.json
```

Then reuse the session:

```bash
shotsweep capture \
  --sitemap https://example.com/sitemap.xml \
  --session auth.json
```

Credentials can also be supplied through:

```text
SHOTSWEEP_EMAIL
SHOTSWEEP_PASSWORD
```

---

## Bearer authentication

```bash
shotsweep capture \
  --sitemap https://example.com/sitemap.xml \
  --bearer $API_TOKEN
```

---

## Custom headers

```bash
shotsweep capture \
  --url https://example.com \
  --header "X-Api-Key: $API_KEY"
```

Headers can be repeated when required.

---

## Cookies

```bash
shotsweep capture \
  --url https://example.com \
  --cookie "session=xyz; Domain=example.com"
```

> **Security:** do not commit real credentials, tokens, or session cookies to your repository.

---

# ⚙️ Configuration

ShotSweep can read a:

```text
shotsweep.config.json
```

or:

```text
.shotsweeprc.json
```

Example:

```json
{
  "sitemap": "https://example.com/sitemap.xml",
  "viewport": [
    "1440x900",
    "390x844"
  ],
  "mode": "full",
  "out": "./screenshots"
}
```

Then:

```bash
shotsweep capture
```

CLI flags override configuration-file values.

This makes ShotSweep suitable for committing a project's visual-testing configuration directly alongside the application.

---

# 🔁 Capture + Diff Configuration

Capture and diff can share one configuration file.

```json
{
  "sitemap": "https://example.com/sitemap.xml",

  "viewport": [
    "1440x900",
    "390x844"
  ],

  "mode": "full",
  "out": "./screenshots",

  "diff": {
    "out": "./diff",
    "threshold": "0.2%",
    "zip": true
  }
}
```

The top-level configuration is shared.

The `diff` object provides diff-specific overrides.

An explicit CLI argument always takes priority.

---

# ⏸️ Large Runs and CI

Large websites can contain hundreds or thousands of URLs.

ShotSweep includes controls for managing those runs:

```bash
--limit <n>
--offset <n>
--resume
--concurrency <n>
--timeout <ms>
--retries <n>
```

For example:

```bash
shotsweep capture \
  --sitemap https://example.com/sitemap.xml \
  --limit 100 \
  --offset 200
```

Or retry failed pages:

```bash
shotsweep capture \
  --sitemap https://example.com/sitemap.xml \
  --retries 2
```

You can also resume a capture:

```bash
shotsweep capture \
  --sitemap https://example.com/sitemap.xml \
  --resume
```

### Concurrency

ShotSweep can capture pages in parallel:

```bash
--concurrency 4
```

Because each capture uses a real browser page, increasing concurrency also increases CPU and memory usage.

ShotSweep warns when concurrency is likely to exceed the available CPU capacity rather than pretending that more workers always means faster execution.

---

# 📋 Every Run Produces a Manifest

Each capture run produces a:

```text
manifest.json
```

The manifest records information such as:

* URL
* viewport
* capture mode
* screenshot path
* file size
* timestamp
* run information

This manifest is what allows two independent runs to be compared later.

It also makes capture output useful as a CI artifact rather than just a directory full of images.

---

# 📦 ZIP Output

Bundle a capture or diff:

```bash
shotsweep capture \
  --sitemap https://example.com/sitemap.xml \
  --zip
```

Or:

```bash
shotsweep diff \
  before/manifest.json \
  after/manifest.json \
  --zip
```

Useful for handing results to:

* designers
* QA
* developers
* clients
* CI artifacts

---

# 🤖 AI-ready Summaries

ShotSweep can produce an AI-ready summary of a capture run:

```bash
shotsweep capture \
  --sitemap https://example.com/sitemap.xml \
  --describe
```

The goal is not to make AI part of the actual regression decision.

The visual comparison remains deterministic.

Instead, `--describe` makes the resulting run easier to hand to a model or human reviewer for higher-level analysis.

---

# 🧪 A Practical CI Workflow

A simple visual regression pipeline can look like this:

```text
Pull Request
     │
     ▼
Build application
     │
     ▼
Start preview / test server
     │
     ▼
ShotSweep capture
     │
     ▼
Compare against baseline
     │
     ├── no visual changes → ✅
     │
     └── visual changes    → ❌
                              │
                              ▼
                         CI artifacts
                         old / new / diff
```

The important part is that ShotSweep does not need to replace your existing test stack.

You can keep using:

* unit tests
* integration tests
* API tests
* end-to-end tests
* accessibility tests

and add visual regression alongside them.

---

# 🧰 Example CI Command

A pipeline can run:

```bash
npm run build

shotsweep capture \
  --sitemap http://localhost:3000/sitemap.xml \
  --out ./visual/current \
  --viewport 1440x900 \
  --viewport 390x844

shotsweep diff \
  ./visual/baseline/manifest.json \
  ./visual/current/manifest.json \
  --out ./visual/diff \
  --json
```

The important property is the exit code.

If ShotSweep detects a visual regression:

```text
exit code != 0
```

Your CI system can therefore fail the job automatically.

---

# 🧱 What ShotSweep is not

ShotSweep is intentionally not trying to be everything.

It is not:

* a hosted visual testing dashboard
* a replacement for Playwright
* a replacement for end-to-end testing
* an AI judge deciding whether a page "looks good"
* a browser automation framework
* a test runner for application logic

ShotSweep focuses on one job:

> **Make visual state reproducible and comparable from the command line.**

---

# 🆚 Why not just use Playwright?

ShotSweep uses Playwright.

That is intentional.

Playwright is excellent at browser automation.

But a visual regression workflow still needs decisions around:

* how URLs are discovered
* how sitemap indexes are handled
* how local and production origins are mapped
* how screenshots are organized
* how runs are manifested
* how multiple viewports are represented
* how authenticated sessions are reused
* how two runs are matched
* how diffs are reported
* how CI knows whether to fail

ShotSweep packages those decisions into a focused CLI.

Instead of building the same visual-capture plumbing for every project, you can run:

```bash
shotsweep capture
```

and:

```bash
shotsweep diff
```

---

# 🪶 Design Philosophy

ShotSweep follows a few simple principles.

### 1. CLI first

It should work naturally in:

```text
terminal
CI
scripts
npm
shell
Docker
```

### 2. Deterministic where possible

Visual comparison should be understandable.

If something changed, the output should show you where and how.

### 3. Keep the dependency footprint reasonable

ShotSweep uses Playwright for browser automation but keeps its own comparison layer dependency-light.

### 4. Don't hide the artifacts

Screenshots, manifests, and reports should belong to the developer.

They should be easy to inspect, archive, move, or attach to a CI run.

### 5. Don't require a hosted service

ShotSweep can be used entirely locally.

No account is required to run a capture.

No external dashboard is required to inspect a diff.

---

# 📚 Documentation

Full documentation:

**[https://shotsweep.nforshifu234dev.com](https://shotsweep.nforshifu234dev.com)**

Useful starting points:

* Quick Start
* Capture
* Authentication
* Visual Comparison
* Diffing Two Runs
* CI/CD
* Configuration

---

# 🤝 Contributing

ShotSweep is open source and contributions are welcome.

You can contribute through:

* bug reports
* feature requests
* documentation
* tests
* performance improvements
* CI integrations
* new input sources
* visual regression improvements
* browser/capture improvements

Before opening a pull request, see: [CONTRIBUTING.md](CONTRIBUTING.md)

Issues and discussions are also welcome.

---

# 📄 License

MIT License.

Free for personal and commercial use.

Copyright © NFORSHIFU LOGICFORGE LTD

---

# 🌐 The NFSFU234 Ecosystem

ShotSweep is part of the NFSFU234 ecosystem — a collection of developer tools and products built around a simple philosophy:

> **Solve a real problem. Keep it light. Make it useful on its own.**

### `@nfsfu234/formvalidation`

HTML-first form validation built around the attributes already present in your forms.

[https://formvalidation.nforshifu234dev.com](https://formvalidation.nforshifu234dev.com)

### `@nfsfu234/tour-guide`

React onboarding tours and product walkthroughs.

[https://tourguide.nforshifu234dev.com](https://tourguide.nforshifu234dev.com)

### `@nfsfu234/shotsweep`

CLI-based website capture and visual regression testing.

[https://shotsweep.nforshifu234dev.com](https://shotsweep.nforshifu234dev.com)

### WishIT

A product for preserving wishes and memories digitally.

[https://wish-it.app](https://wish-it.app)

---

# 🇳🇬 Built from Nigeria

ShotSweep is built by:

**IAMNOTSHIFU**

through:

**NFORSHIFU234 Dev**

and published under:

**NFORSHIFU LOGICFORGE LTD**

🇳🇬

---

# 🎯 Final Word

A successful build does not guarantee a successful interface.

A test suite can tell you that your application works.

ShotSweep helps answer a different question:

> **Does it still look the way we expect?**

Capture it.

Change it.

Compare it.

Let CI catch the difference.

**Capture everything. Miss nothing.** 📸

— Built by NFORSHIFU234 Dev 🇳🇬
