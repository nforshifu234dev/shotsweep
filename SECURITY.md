# Security Policy

## Reporting a vulnerability

Email [contact via nforshifu234dev.com](https://nforshifu234dev.com) rather than opening a public issue. Include what you found, how to reproduce it, and its potential impact.

You'll get an acknowledgment within a few days, and a fix or mitigation timeline once the issue is confirmed. Please give us reasonable time to address a confirmed issue before any public disclosure.

## Supported versions

Only the latest published version on npm receives fixes.

## Release process (maintainers)

Releases are automated via [release-please](https://github.com/googleapis/release-please). Commits to `main` following conventional commit format (`feat:`, `fix:`, etc.) are tracked automatically. When ready to release, merge the open "chore: release" PR that release-please maintains — merging it creates the version tag and GitHub Release, which triggers `npm-publish.yml` to publish.