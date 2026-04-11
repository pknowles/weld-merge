# Python & Machine Learning Standards

- **GPU Only Focus:** CPU transfers (`.item()`, `.cpu()`, loop evaluation on tensors) are strictly forbidden during training, except at serialization/visualization boundaries. No `device="cuda"` parameters.
- **Type Safety Above All:** 
  - Use `@dataclass(frozen=True)` by default.
  - No `Any`, type casts, `# type: ignore`, or `# noqa`.
  - Avoid `Optional` and default parameters whenever possible. They silently skip operations.
  - `TYPE_CHECKING` and `from __future__ import annotations` imports are forbidden. Eliminate circular dependencies through refactoring.
  - Tensor shapes and ranks are a strict contract. Validate them explicitly.
- **No Runtime Dispatch:** Avoid `isinstance`, `hasattr` or type-string checking in business logic. Expect the correct type natively or use Type Erased interfaces.
- **Implicit Resource Management:** Rely on CPython refcounting and deterministic `__del__` for cleanup. Avoid explicit `.release()` or cyclic references. Context managers (`with`) are acceptable for strictly scoped lifetimes (locks, file streams).
- **Refactoring Tools:** Prefer utilizing `rope` scripts for large or wide-reaching refactors
