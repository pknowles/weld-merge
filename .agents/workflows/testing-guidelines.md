---
description: 
---

# Testing & Quality Checks Workflows

## Global Philosophy
- Don't blindly write tests for the sake of LOC or syntax verification. Tests must execute core logic to ensure project goals are met.
- Do not test that the code does what the code does. This is far worse than useless. See the writing tests section below.
- **Never Duplicate Production Code in Tests.** Use utility functions or refactor dependencies instead of copy/pasting.
- Don't copy or reimplement project code in tests - then you're testing tests which is worse than pointless.
- Fix broken tests/lint warnings immediately, even if unrelated to your current step. Stop and debug. Do NOT skip tests without proof of external fault and explicit user permission.
- **Take Ownership of Failures:** Claiming its "pre-existing" doesn't help because at the end of the day the test is still failing. Check with the user that another agent isn't working concurrently and then fix it.

## Mocking

To mock or to write an end to end test? This should not be something you need to ask. Simple answer. Either:
1. You can achieve the same level of coverage with appropriately simple mocking.
   Do that, it'll be faster to run and tangle less.
2. You'd have to mock an entire API or shortcut real project code, so you
   wouldn't be getting coverage anyway and should be pulling in more real code
   to test properly.

If your mocked object has to do non-trivial stuff (e.g. duplicate real code) you're not mocking, you're reimplementing something in test code.

## Frontend (JS/TS) Verification
Run these from the root directory:
1. `npm run build` - Full build including type checking and bundling.
2. `npm run pre-checkin` - Runs linting, build, coverage tests, and quality audits (knip, depcruise, jscpd). **Must pass before commit.**

## Writing tests for LLMs

1. List all the intended use cases, the happy paths.
2. List all the edge cases for each of the happy paths.
3. Describe the expected outcomes for each case
4. Describe two or three ways you can test whether the expected outcome happened or not, explaining why they verify the outcome and detect anything other than the outcome - your validation ideas
5. Anything else you can think of?

Stop here and ask the user to check your progress.

6. For each of the use cases, describe one result that would be incorrect. Would your test catch the wrong output?
7. For each of your validation ideas, evaluate how well they will work. Do they actually verify whether the feature works in spirit? I.e. not just that the code does what it does. Do they test solid invariants that match the use cases, allowing for the implementation to change yet still verify it produces the right result?
8. Replace any useless tests you found with test that would catch incorrect usage and repeat the above negative testing thought experiment.
