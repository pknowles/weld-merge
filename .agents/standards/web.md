# Web (JS/TS/React) Standards

- **Strict Type Safety:**
  - `any`, `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, and `biome-ignore` are completely forbidden.
  - Avoid `Partial<T>` and `?` optional parameters. If a dependency is needed, require it.
- **React State & Composable UI:**
  - Avoid global "Everything Contexts". Components must receive exactly what they need via Props.
  - Compose high-level features strictly from independent, single-responsibility functions and UI components.
  - Do not wrap standard React hooks/functions without explicit reason (e.g., no custom `useAppEffect` just to wrap `useEffect`).
- **Resource Lifecycle (React RAII):**
  - Always return cleanup functions from `useEffect` for subscriptions, timers, or event listeners. Unmounting must tear down resources strictly.
- **No Defensive Plumbing:**
  - Do not silently handle invalid input with fallbacks or `console.log()` traps. Throw errors instead.
  - Avoid `yield` loops as async patterns can easily confuse LLMs.
  - Do not map or re-shape arrays solely for internal component border passing if the raw object works fine.
- **Boundaries & Dependencies:**
  - If Knip or Dependency-Cruiser flag unused/illegal code, you must remove or fix the code. Do not add exceptions to `knip.json` or `.dependency-cruiser.js`.
  - Add new constraint rules when creating new architectural domains to enforce strict separation.
