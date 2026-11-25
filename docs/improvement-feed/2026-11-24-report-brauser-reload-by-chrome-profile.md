## 2026-11-24 — Report Brauser reload by Chrome profile

Add a nonidentifying profile acknowledgement to `scripts/dev/deploy-live --loaded` so a rollout can verify the extension and host build for each participating Chrome profile. The existing check reads the latest Brauser hello for the installation, which confirms the reload in the profile that sent it. Exercise two profiles and a partial reload in a synthetic deployment test.
