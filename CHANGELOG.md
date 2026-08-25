# Changelog

All notable changes to the NFSFU234 ShotSweep Library will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and adheres to Semantic Versioning.

## [0.1.0] — NFSFU234 Open Source Day (2026-08-25)

**Initial public release.**

NFSFU234 ShotSweep is a command-line screenshot and visual regression tool built for developers who need repeatable website captures, automated visual comparisons, CI-friendly workflows, and reliable screenshot automation at scale.

This is the first public release of ShotSweep and is being launched as part of **NFSFU234 Open Source Day**, alongside the established [NFSFU234 Tour Guide](https://tour-guide.nforshifu234dev.com/) and [NFSFU234 Form Validation](https://form-validation.nforshifu234dev.com/).

### Added

* Capture single URLs, arrays, CSVs, or complete sitemaps, including sitemap-index files.
* Full-page and section-sliced screenshot modes.
* Multiple viewport captures per run.
* Named viewport presets:

  * `desktop`
  * `tablet`
  * `mobile`
* Raw `WxH` viewport definitions.
* `--replace-origin` for reusing production sitemaps against localhost or staging environments.
* Generic authentication support:

  * saved sessions via `shotsweep login`
  * bearer tokens
  * custom headers
  * cookie injection
* Authentication workflows verified against real authenticated captures.
* `shotsweep diff` for pixel-comparing two capture runs by manifest.
* Diff output includes:

  * `old.png`
  * `new.png`
  * `diff.png`
  * `diff-report.json`
* `--zip` support for bundling diff output.
* Non-zero exit codes when real visual changes are detected, allowing ShotSweep to gate CI pipelines.
* `--concurrency` with CPU-aware warnings.
* `--timeout` and `--retries` for real-world capture reliability.
* Retry behavior verified against an actual transient failure.
* `--zip` support on `capture` for bundling capture output.
* `--dry-run` for previewing resolved targets without taking screenshots.
* `--json` and `--quiet` for scriptable and CI-friendly output.
* `--debug` for detailed diagnostic information.
* `--describe` for generating an AI-ready summary of a completed capture run.
* `--resume` for skipping URL/viewport pairs already captured in an existing output manifest.
* `--verbose` for persistent per-job completion output, particularly useful with concurrent captures.
* `--limit` and `--offset` for capturing a specific slice of resolved URLs.
* `--wait-until <domcontentloaded|load|networkidle>` for controlling when a page is considered ready for capture.
* `--threshold` supports:

  * raw ratios
  * percentages such as `"0.1%"`
  * named presets: `strict`, `default`, and `loose`
* Configuration file support through:

  * `shotsweep.config.json`
  * `.shotsweeprc.json`
* `shotsweep diff` reads the same configuration file as `capture`, with an optional `diff` section for diff-specific overrides.
* Explicit CLI flags take precedence over configuration-file values.
* CLI `name`, `description`, and `version` are now read from `package.json` at runtime rather than duplicated as hardcoded values.
* Per-file `manifest.json` logging including:

  * URL
  * mode
  * viewport
  * file path
  * file size
  * timestamp

### Release

NFSFU234 ShotSweep is launching as a **new project** for NFSFU234 Open Source Day on **August 25, 2026**.

It joins the NFORSHIFU234 Dev open-source ecosystem alongside [NFSFU234 Tour Guide](https://tour-guide.nforshifu234dev.com/) and [NFSFU234 Form Validation](https://form-validation.nforshifu234dev.com/).

Learn more at the [NFSFU234 ShotSweep website](https://shotsweep.nforshifu234dev.com/).

Part of the NFORSHIFU234 Dev open-source ecosystem, published for **NFSFU234 Open Source Day**.
