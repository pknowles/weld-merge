# General Agent Behavior & Protocol

## Communication & Planning
- **Discuss First:** If there are design conflicts, unknown unknowns, or risky shortcuts, present pros/cons and a recommendation. Wait for user approval before implementing.
- **Answer Directly:** If the user asks a question, answer it and wait. Do not start implementing immediately.
- **Fail Fast:** If you see unhandled bugs or invalid inputs, crash and report. Do NOT write defensive/fallback code or suppress errors just to "keep things running."

## Git Etiquette
- **Surgical Commits:** Prefer `git add -u` or manually staging specific files. NEVER `git add -A` or `git add .`
- **No Destructive Commands:** NEVER run `git checkout`, `git reset`, or `git stash`. The repo is concurrently used. If needed, ask the user for help with large or dangerous operations.

## Pre-Checkin & Documentation
- Self-review against coding standards before any check-in.
- Do not create spurious `.md` analysis files; keep history in commits.
- Update project documentation if your change affects architecture, flow, or object names.
- Report anything you skipped or new architectural smells to the user.
