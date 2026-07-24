# @jfs/modal-kit — working notes for Claude

Shared, dependency-free accessible-dialog plumbing for the JFS family of
buildless static PWAs: focus trap + focus save/restore, iOS-safe
`position: fixed` scroll-lock, a central Escape stack, marker-guarded
`inert`/`aria-hidden` siblings, bfcache cleanup, and an opt-in history
sentinel so the Back button closes the topmost dialog. Consumers vendor
this kit via its own CLI rather than installing it at runtime, so a change
here reaches an app only once that app bumps its pin and re-runs
`vendor:sync`.

## Pull requests

Open pull requests **ready for review — never as drafts.** This applies to
PRs opened by automated Claude Code sessions too: some hosted environments
default to creating drafts, so mark the PR ready as part of opening it
rather than leaving it for a follow-up.
