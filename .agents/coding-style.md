# JavaScript & React Design Philosophy

These design decisions reflect an effective approach to building maintainable, scalable, and safe web applications using TypeScript and React. Agents should adhere to these principles when writing or refactoring code.

## Strict Initialization & Type Safety

**Dependencies are implied by the type system.**
Avoid delayed initialization. Do not create empty objects (`{}`) or `Partial<T>` objects only to mutate and fill them in later. If a component or function requires data, it should be passed at initialization/render time. This makes code unambiguous and less error-prone. By forcing complete initialization, TypeScript will immediately remind the developer (or agent) to supply the necessary dependencies. Let the TS compiler help us design better.

**Strictly avoid "optional" dependencies.**
If optionality is truly needed, you must have a very strong justification. Otherwise, safety comes first: force dependencies to be present, and require explicit types instead of `?` or `Partial<T>`. This firmly aligns with RAII and strict initialization—if you have an object, you know it is fully initialized and valid.

## Composable, Independent Entities

**Avoid the "Everything Context".**
It’s common to pass around a massive `AppContext` or global state object containing everything from user data to API clients. This is convenient but tightly couples components to a heavy ecosystem. Instead, components and functions should be constructed with exactly what they need (via Props or specific arguments).

The primary goal of the architecture is modularity. Application features should be built through small, independent, single-responsibility functions and UI components. They must be highly reusable, composable, and pluggable. 

Shortcuts and higher-level application components are encouraged, but they must be built purely by composing intermediate objects. This ensures that the application remains maintainable and that complex specific features can be built from primitive components without requiring monolithic "god objects".

## Simple, Singular Implementation

Don't over-engineer to support hypothetical future edge cases. Pick one standard way to do something and do it well, without limiting core features.

Rely on standard, native JavaScript/React APIs whenever possible. Don't build massive abstraction layers over standard browser APIs (like `fetch` or `localStorage`) unless there is a tangible, immediate benefit. One simple, clear implementation is better than a flexible but complex one.

## Architectural Boundaries & Quality Tools

**Never decay code quality.**
Agents MUST NOT relax linter rules, Knip configuration, or Dependency-Cruiser rules to "force" a build to pass. 
- **NO SILENCING ALLOWED**: It is strictly forbidden to use `// @ts-ignore`, `// @ts-expect-error`, `// biome-ignore`, or `// eslint-disable` comments. If a type is too complex to figure out immediately, it is better to refactor the data structure until the types are simple and obvious, rather than silencing the compiler. Do not use `any` to bypass the type checker.
- If an architectural boundary is violated, the code must be refactored to respect the boundary. 
- When creating new large modules, agents should proactively update configuration files to ensure the architecture scales safely:
  - **`.dependency-cruiser.js`**: Encode new valid/invalid import boundaries for the new module.
  - **`knip.json`**: Add any *new* application entry points (like new scripts or exposed modules) so the dead-code analysis remains accurate for the new feature graph.
  - **`tsconfig.json`**: Update path aliases (if the project uses them) to keep cross-module imports clean and trackable.

## Version Control Etiquette

**No destructive or blanket Git operations.**
Agents MUST adhere to strict operational constraints when interacting with Git:
- **No `git checkout` or `git reset` on files or branches.** These are destructive operations. If an agent believes changes need to be discarded, it MUST ask the user to perform the manual revert.
- **No `git add -A` or `git add .`** Agents must ALWAYS add files surgically and individually (e.g., `git add src/components/Button.tsx`). Blanket commits are strictly forbidden to prevent accidental staging of logging, experimental work, or unintended side effects.


## Clear State Ownership & Lifecycle Management

**The React equivalent of RAII.**
Be extremely deliberate about where state lives and who owns it. Keep state local by default and only lift it up when absolutely necessary.
Always clean up side effects. If you open a subscription, set a timer, or bind an event listener in a `useEffect`, you MUST return a cleanup function to prevent memory leaks. Treat component unmounting as strict teardown time.

## Data-Oriented & Performance Conscious

Avoid unnecessary object or array transformations. Don't map over arrays or copy data into new shapes just to satisfy an arbitrary internal boundary if the original shape works fine. Pass the raw data structures directly where applicable. Avoid premature optimization, but be mindful of unnecessary re-renders in React by keeping data structures stable and leveraging `useMemo`/`useCallback` when passing objects/functions as dependencies.

## Zero-Friction Plumbing

**No effort plumbing.**
Use existing structures to hold data. If an external library or API takes a specific configuration object, construct and pass that object directly. There is no need to unpack, forward, and repack arguments through multiple custom wrapper functions. This is the single definition rule.

Once a core library (like React, or a state management tool) is instantiated, use its API directly. Don't wrap standard hooks or functions in custom "helper" abstractions just for the sake of it (e.g., don't write a `useAppEffect` that just calls `useEffect`). This reduces cognitive load for anyone familiar with the standard JS/React ecosystem and online examples.
