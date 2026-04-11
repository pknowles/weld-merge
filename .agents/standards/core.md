# Core Architecture Principles

These principles apply across all languages and frameworks in this repository.

- **Data-Oriented Design:** Avoid unnecessary intermediate transformations. Retain and pass original data structures. Prefer batch operations over element-wise loops.
- **One Way To Do Things:** Simple beats flexible. Pick one standard approach. Do not over-engineer for hypothetical future edge-cases. Do not accept multiple parameter types (no unions like `str | Path` where single types suffice).
- **Objects Own Data, Not Verbs:** Group code by feature, not by type. Name objects after the data they hold. Compose complex functionality by stringing together smaller primitive objects rather than writing monolithic "God" objects or functions.
- **Strict Initialization (RAII):** Objects must be fully initialized and valid upon construction. No empty initializers (`{}`) that are populated later. No `__post_init__` partial cleanups. If an object takes a resource, it must clean it up locally upon its destruction.
- **Preserve Context & Comments:** Keep all existing comments when editing or moving code, especially `WARNING`, `TODO`, or `DO NOT REMOVE`.
- **Zero-Friction Plumbing:** Build and pass configuration objects directly if underling libraries need them. Do not create wrappers around standard library APIs unless adding significant, documented value.
- **Never Silence Quality Tools:** Linter exceptions, type ignores, and rule weakening are **forbidden**. Fix the underlying design instead.
- **Comprehensive Implementation:** If a feature applies to multiple modes, formats, or variants, implement it for all of them. Do not default to only handling the most common case.
