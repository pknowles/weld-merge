---
description: 
---

# Testing & Quality Checks Workflows

## Global Philosophy
- Don't blindly write tests for the sake of LOC or syntax verification. Tests must execute core logic to ensure project goals are met.
- **Never Duplicate Production Code in Tests.** Use utility functions or refactor dependencies instead of copy/pasting.
- Fix broken tests/lint warnings immediately, even if unrelated to your current step. Stop and debug. Do NOT skip tests without proof of external fault and explicit user permission.
- **Take Ownership of Failures:** Never assume test or lint errors are "pre-existing." You must investigate and fix them.
- **Avoid Destructive Testing:** Do not use override or data-destructive flags by default when testing scripts.

## Frontend (JS/TS) Verification
Run these from the root directory:
1. `npm run build` - Full build including type checking and bundling.
2. `npm run pre-checkin` - Runs linting, build, coverage tests, and quality audits (knip, depcruise, jscpd). **Must pass before commit.**
