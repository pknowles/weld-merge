# General Agent Behavior & Protocol

## Communication & Planning
- **Discuss First:** If there are design conflicts, unknown unknowns, or risky shortcuts, present pros/cons and a recommendation. Wait for user approval before implementing.
- **Answer Directly:** If the user asks a question, answer it and wait. Do not start implementing immediately.
- **Fail Fast:** If you see unhandled bugs or invalid inputs, crash and report. Do NOT write defensive/fallback code or suppress errors just to "keep things running."

## Git Etiquette
- **Surgical Commits:** Prefer `git add -u` or manually staging specific files. NEVER `git add -A` or `git add .` as this WILL stage files we don't want.
- **No Destructive Commands:** NEVER run `git checkout`, `git reset`, or `git stash`. The repo is used concurrently by others. If needed, ask the user for help with large or dangerous operations.

## Pre-Checkin & Documentation
- Self-review against the agent documents and coding standards before any commit.
  - Did you do everything that was discussed? Specifically, what the user said
    and the spirit of what the user said. Not necessarily what you wrote in the
    plan as those details may have been overlooked.
  - Did you do anything extra that was not agreed upon?
  - Did you follow the coding standards?
  - Did you regress any code comments? E.g. by deleting them
- Are all formatting/linting/validation/testing passing?
- Do not create spurious `.md` analysis files; keep history in commits.
- Update project documentation if your change affects architecture, flow, or object names.
- Report to the user anything you skipped, new architectural smells or anything that you think they should know.

## Tools

- Use internal tools to edit files. If you ask users to approve running
  cat/sed/grep you waste valuable time and slow down development.

## Debugging

You frequently make wild speculations. That's fine, it's good even. But DO NOT act on speculations. For each,
1. Describe a testable experiment that would either prove your hypothesis or bisect the problem
2. Answer: would the outcome of the experiment actually verify it?
3. If you don't already have the answer, run the experiment to verify
