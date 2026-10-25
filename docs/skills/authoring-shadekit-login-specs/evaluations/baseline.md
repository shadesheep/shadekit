# Skill evaluation record

## RED — current Skill without ShadeKit source

Date: 2026-10-25

The current `SKILL.md` was evaluated as a standalone document against `scenarios.json`. This harness has no fresh-subagent tool, so this RED record is an executable dependency/behavior review by the same agent, not a claimed fresh-context model trial.

Observed instructions and resulting behavior:

- `事实源`: requires `entrypoints/tools/account-switch/spec/types.ts`, `validate.ts`, `run.ts`, `trial.ts`, `http.ts`, `session.ts`, `package.ts`, plus `docs/login-specs/*`. Verbatim: “另读取 ShadeKit 当前实现”. Outside a checkout none of these paths exists, so all three scenarios lose the authoritative contract.
- `验证后交付`: verbatim requires “实际调用 `validateLoginSpec(spec)`、`buildConfigPackage(...)` 和 `validateConfigPackage(pkg)`”. A standalone document provides no functions or executable substitute, so no scenario can truthfully reach the existing validation gate.
- Gated API scenario: the prose warns about premature `auth.write`, but there is no executable gate lint or offline response injection. The agent can emit plausible JSON but cannot demonstrate zero session writes on a 200 business rejection.
- Page-managed scenario: the prose can choose `auth.mode: "page"`, but has no local schema/R1–R7 validator and no defined `NOT_SIMULATED` status for browser behavior.
- Unsupported/missing-evidence scenario: the existing BLOCKED instruction remains applicable and is the only scenario whose expected outcome does not depend on missing executables.

Baseline conclusion: the current Skill is not independently verifiable without ShadeKit source. No baseline validation or login success is claimed.

## GREEN — self-contained Skill outside the repository

The Skill alone was copied to `<temp>/shadekit-skill-green.<id>/skill`; commands ran from a separate work directory with no ShadeKit checkout used.

Observed results:

- API scenario: `package.mjs` produced complete dual JSON; `validate.mjs` returned `SNAPSHOT_STATIC_VALIDATED`; success simulation returned `PASS` with the expected request/session; business-rejection simulation returned `PASS`, actual `success:false`, `errorCode:"CONFIG_INVALID"`, and empty Cookie/localStorage/sessionStorage.
- Page-managed scenario: static package/spec validation returned `SNAPSHOT_STATIC_VALIDATED`; simulation returned `NOT_SIMULATED`, made zero requests/writes, and exited 2 as documented. No browser behavior or real login was claimed.
- Unsupported/missing-evidence scenario: documentation review confirms the rewritten Skill requires `BLOCKED + gap + targeted question` for MFA, unsupported algorithms, missing request/session evidence, and unprovable gates. No model-generated output is claimed for this review.
- `scenarios.json` now contains observable review checklists, a no-guidance control definition, and five requested fresh-context repetitions per scenario.

Limitation: this harness has no fresh-subagent or raw-model sampling tool. The five fresh-context repetitions and no-guidance control are specified but were **not executed**. GREEN above is an artifact/CLI evaluation by the same agent, not a claim of independent model compliance testing. Real import, real session writing, and real login remained `NOT_RUN`.
