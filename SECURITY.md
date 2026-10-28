# Security policy

## Supported versions

ohpert is pre-1.0. Security fixes are made on the `main` branch and released in
the latest minor version.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Use GitHub's **private vulnerability reporting** for this repository
(_Security_ → _Report a vulnerability_). If that is unavailable, contact the
maintainers through a private channel listed on the repository profile.

Include:

- the affected version or commit;
- a minimal reproduction or proof of concept;
- the impact you believe is possible;
- any suggested mitigation.

We will acknowledge the report, investigate, and coordinate a disclosure
timeline with you. Please give us a reasonable opportunity to ship a fix before
publishing details.

## Scope

ohpert runs on your machine and can read files and execute build commands inside
the repositories you add. Reports are especially welcome for:

- path traversal or symlink escapes outside a registered repository;
- bypasses of the command allow/deny checks;
- cross-origin or DNS-rebinding access to the local API;
- worktree, branch, cleanup, or rollback operations that touch the wrong files;
- leaking API keys, repository contents, or telemetry to an unintended party;
- injection through requirement text, repository files, or model output.

## Local data and secrets

- `.data/` contains the SQLite database, `settings.json` (which may include an
  API key), and temporary Git worktrees. It is created with owner-only
  permissions (`0700`; `settings.json` is `0600`).
- The API key is stored in plain text on your machine. Protect your user
  account and disk; prefer a scoped, revocable key.
- ohpert has no telemetry. Network requests go only to the OpenAI-compatible
  endpoint you configure.
