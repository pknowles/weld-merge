---
description: Post-Implementation Quality Checks
---

# Testing & Quality Guidelines

After implementing features you must read through the coding-style.md and make sure everything you did conforms. Check you completed everything asked of you, that there are no regressions, introduced bugs, code duplication or dead code. Be honest and report any deficiencies to the user immediately.

When implementing new features or making significant refactors in the `vscode-extension` directory, you MUST run these structural and quality tools post-implementation.

1. **Dead Code & Dependencies**: Run `npm run knip` from the `vscode-extension` directory.
   - Review any unused files, exports, or dependencies and remove them. **DO NOT** add exceptions to `knip.json` just to bypass errors.
2. **Duplication**: Run `npm run jscpd` from the `vscode-extension` directory.
   - If there is significant code duplication, abstract the logic into shared utility functions.
3. **Modularity**: Run `npm run depcruise` from the `vscode-extension` directory.
   - Ensure you haven't introduced any circular dependencies or invalid architectural boundaries.
   - **CRITICAL RULE FOR AGENTS**: If dependency-cruiser flags an error, you **MUST FIX THE CODE**. Do **NOT** relax constraints or add ignore rules to `.dependency-cruiser.js` to silence errors.
   - Whenever you implement a new major domain or module, you should proactively **ADD** new strict rules to `.dependency-cruiser.js` to protect its boundaries moving forward.
4. **Linting & Formatting**: Run `npm run lint` and `npm run format` from the `vscode-extension` directory.

NOTE: There is a linting pre-commit hook to lint staged changes automatically.

// turbo-all