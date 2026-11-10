# Security policy

## Supported versions

The historical preview is `0.1.0-preview.0`; `0.2.0` is the newest published non-preview release.
The newest published non-preview client release is maintained; older client versions and previews
are superseded, with no separate backport commitment. Preparing `0.2.1` does not supersede the
published `0.2.0` until the new version is actually published. Runtime compatibility does not imply security maintenance of
end-of-life Node.js releases; prefer a maintained Node.js runtime.
Check exact registry availability and release announcements; this repository policy does not
itself attest that a release or security fix has been published.
Security fixes are developed on `main` and require a separately reviewed and authorized release;
updating `main` alone does not fix an already installed package. Consumers should pin a reviewed
version, retain their lockfile, and update when a security-fix release is announced. Older preview
versions may be superseded rather than maintained as separate backport branches.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Please do not disclose a
suspected vulnerability in a public issue, discussion, or pull request.

Include the affected version or commit, reproduction steps, impact, and any suggested mitigation.
Reports involving credentials should use revoked test credentials only; never include active Codex,
OpenAI, GitHub, or third-party secrets.
