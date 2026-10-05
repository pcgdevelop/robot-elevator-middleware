
## Engineering standard — repository delivery

Scope: this repository. Setup pcgdevelop/robot-elevator-middleware#4; docs docs/engineering-standard/README.md.
Read existing repository rules, relevant source and the handbook before implementation. Work from one issue with role/value, bounded scope, concrete success/error/access criteria, synthetic fixtures and test plan. Refine unknown requirements rather than inventing them.
Branch hermes/<issue>-<short-name>; commit includes pcgdevelop/robot-elevator-middleware#<issue>; PR title [#<issue>] with matching Refs/Closes. Document criteria -> files -> actual tests in docs/engineering-standard/acceptance/issue-<issue>.md. Add concise ticket references to changed non-obvious business/security rules, not every line.
Write or update the specification/handbook before behavior changes. Keep source discovery, intended behavior and actual acceptance separate. Existing product documentation, CI and deployment rules remain authoritative for their scope.
Use meaningful risk-based tests. Do not treat an empty script or agent status as acceptance. Independent application review follows implementation; the same run cannot approve its own app code. Operator-only docs/CI bootstrap is the narrow exception after actual checks and scope inspection.
Do not weaken the gate to pass your change. Do not copy operator credentials or broaden agent permissions. Real deployments, data migrations, messaging, payments, advertising and physical hardware actions require the concrete authorized workflow. Test with stubs/simulators and synthetic data.
One implementation per agent; explicit Backlog/Ready/In Progress/Review/Blocked/Done state. Continue eligible goals within the configured budget without fabricated work or paid fallback providers.
