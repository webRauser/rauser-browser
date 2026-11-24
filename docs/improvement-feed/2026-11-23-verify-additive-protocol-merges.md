## 2026-11-23 — Verify additive protocol merges semantically

Change: Add a reusable read-only check that compares a resolved protocol schema with both merge parents, requiring the complete union of request/result references and preservation of every definition before regenerating Rust and TypeScript.
Why: Two independently green feature branches appended different request/result variants to the same lists; a text-only resolution could silently drop one feature while generated files still compile.
Where: The protocol merge workflow, `protocol/generate.py` validation and the contributor conflict-resolution guidance.
