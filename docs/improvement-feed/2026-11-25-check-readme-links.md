## 2026-11-25 — Check README links in documentation CI

Change: Check repository-relative paths and heading fragments in the README in the docs-only CI job.
Why: The README now points readers directly to the feature contracts and runbooks. A heading rename can break that path while the current documentation checks still pass.
Where: `.github/workflows/ci.yml` (docs-checks) and the contributor-document checker.
