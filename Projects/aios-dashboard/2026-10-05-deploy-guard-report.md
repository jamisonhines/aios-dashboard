# Deploy integration guard report

## Commits and scope

- `b31e5db`: guard, real-git tests, npm test wiring, deploy documentation.
- `79dd4fa`: ancestor-commit and untracked-content coverage.
- Evidence artifacts and the replayable mutation harness are committed separately with this report.
- No application deployment, push, or merge performed. Repair-command merges ran only in disposable test repositories.
- Fixtures remain under ignored `.deploy-guard-*` paths for inspection.
- Review is pending. Changed application paths: `.gitignore`, `README.md`, `deploy.sh`, `deployGuard.test.mjs`, `package.json`. No migration, RLS, auth, pricing, redaction, or agent-host safety configuration paths changed.

## REQ-6 decision

Dirty trees refuse by default, including tracked edits and untracked files. Ancestry proves committed content only. `--allow-unmerged` explicitly permits dirty previews and prints warnings before build/copy and after both copies. A missing local integration branch always refuses, even with that flag.

## Tests and requirement coverage

Tests are in `deployGuard.test.mjs`:

- T1: `deploy documentation and test-chain contract`
- T2: `HEAD in integration branch deploys unchanged artifacts and output`
- T3: `HEAD behind integration branch is contained and deploys`
- T4: `untracked files refuse before build or copy`
- T5: `unmerged side branch refuses before build or copy; printed command fast-forwards occupied worktree`
- T6: `AIOS_INTEGRATION_BRANCH override uses named local integration branch`
- T7: `missing local integration branch refuses clearly even with preview flag`
- T8: `--allow-unmerged permits preview in either position with reminders before and after copy`
- T9: `dirty tree refuses with warning; preview permits dirty changes with two reminders`
- T10: `vault path required and invalid arguments refuse before build`

| REQ | Test / evidence | Pass |
| --- | --- | --- |
| REQ-1 | T5, T7, T9 assert untouched target sentinel and no stub build invocation | Yes |
| REQ-2 | T2 default main; T6 override with main present but not containing HEAD | Yes |
| REQ-3 | T5 asserts HEAD and branch, executes the printed shell command against a second worktree holding main, verifies its HEAD, then deploys | Yes |
| REQ-4 | T7 identifies the missing local branch specifically | Yes |
| REQ-5 | T8 tests both flag positions, stderr reminders twice, and combined-stream order before build and after the final copy; T10 requires vault path | Yes |
| REQ-6 | T9 tracked edit refuses then previews actual dirty bytes; T4 untracked file refuses | Yes |
| REQ-7 | T2 compares all three plugin files, exporter bytes, build arguments, and exact original stdout lines; T3 covers a strict ancestor | Yes |
| REQ-8 | T1 checks timeout import and npm chain; fixtures use mktemp, git init, real commits and worktrees, stub npm | Yes |
| REQ-9 | Eleven executable mutations below each fail; restored targeted tests pass after every mutation | Yes |
| REQ-10 | T1 checks the README's three deploy documentation lines | Yes |

No test rewrite or drop: zero deploy-guard tests before, ten after. Two additional tests explicitly cover strict ancestry and untracked content.

## Commands and observed output

```text
node deployGuard.test.mjs
ℹ tests 10
ℹ pass 10
ℹ fail 0

bash -n deploy.sh
(exit 0, no output)

git diff --check
(exit 0, no output)

npm ci
added 16 packages, and audited 17 packages in 1s
3 moderate severity vulnerabilities

npm test
(exit 1 at exportAgentModels.test.mjs after deployGuard and agentModelsModel passed)
AssertionError [ERR_ASSERTION]: native Pi 0.85.1 ModelConfig accepts valid BOM, comments, trailing commas, headers, overrides, thinking map, sampling parameters, and Qwen-style configuration
```

Every command in the npm test chain was also executed individually after installing locked dependencies: 44 files, 42 passed, two failed. The per-file exit statuses are in `2026-10-05-deploy-guard-suite-results.json`. The failures are:

- `exportAgentModels.test.mjs`: the brief's known Pi ModelConfig baseline failure.
- `taskIdClaim.test.mjs`: `ENOENT: no such file or directory, mkdir` at the fixture's `.id-claims/2026-09-17/001`, from the external mint-task-id fixture. Reproduced with exit 1 in an untouched archive of `c8260a9` inside `.deploy-guard-baseline`. This is an additional baseline issue, not a green suite claim.

Initial missing-esbuild failures disappeared after `npm ci`. An attempted archived baseline export-models run instead hit that archive's depth-sensitive external coordination import; the current-tree Pi failure matches the brief, and its test/application files are unchanged from the baseline.

## Mutation proof

Replay command: `node Projects/aios-dashboard/2026-10-05-deploy-guard-mutations.mjs`. Eleven mutations, eleven observed failures, eleven restored targeted green runs. Machine-readable test names and assertion lines are in `2026-10-05-deploy-guard-mutation-results.json`.

All script mutations affect executable conditionals, assignment, printf, function invocation, or cp, not comments. The npm and README mutations deliberately target their configuration/documentation requirements.

Co-guard analysis: fixtures have a valid vault argument and clean real repositories, unless specifically testing dirtiness. Ancestry and dirty checks can also reject a missing-branch fixture, but dirty is cleared by the clean fixture and the preview flag; ancestry is explicitly disabled with the missing-branch mutation. Override fixtures contain both named local branches, avoiding the missing-branch guard. Dirty fixtures have HEAD equal to main. Preview fixtures have a valid branch, clean tree, and the explicit bypass. For the escape-flag mutation, ancestry remains active deliberately: its refusal is the broken escape behavior under test, not a masking rejection of successful bypass. The occupied-worktree repair fixture clears missing-branch and dirty guards. Only an ancestry refusal triggers the repair-command assertion.

| Kind | Requirement | Mutation | Co-guards | Disabled together | FAIL line |
| --- | --- | --- | --- | --- | --- |
| guard | Before `npm run build` and before any copy | Replace ancestry conditional with `if false` | none | n/a | deployGuard.test.mjs, T5: AssertionError [ERR_ASSERTION]: unmerged HEAD must refuse |
| value | The integration branch defaults to `main` | Default main -> integration | none | n/a | deployGuard.test.mjs, T2: AssertionError [ERR_ASSERTION]: Refusing deploy: local integration branch 'integration' does not exist (HEAD 5a2be49). |
| other | exact fast-forward commands to fix it | `--ff-only` -> `--invalid-option` in occupied-worktree command | none | n/a | deployGuard.test.mjs, T5: AssertionError [ERR_ASSERTION]: error: unknown option `invalid-option' |
| guard | If the integration branch does not exist locally, refuse with a clear message | Missing-branch conditional -> `if false` | ancestry | ancestry | deployGuard.test.mjs, T7: AssertionError [ERR_ASSERTION]: Expected "actual" to be strictly unequal to: 0 |
| other | stderr, before and after the copy | Remove first reminder invocation | none | n/a | deployGuard.test.mjs, T8: AssertionError [ERR_ASSERTION]: preview reminder must appear twice |
| guard | A dirty working tree is reported as a warning | Dirty detection -> `if false` | none | n/a | deployGuard.test.mjs, T9: AssertionError [ERR_ASSERTION]: dirty tree must refuse |
| other | same three plugin files | Omit styles.css from cp | none | n/a | FAIL: deployGuard.test.mjs: ✖ HEAD in integration branch deploys unchanged artifacts and output (335.1635ms); Error: ENOENT: no such file or directory, open '<checkout>/.deploy-guard-jCBbyF/target/.obsidian/plugins/aios-dashboard/styles.css' |
| other | Add it to the `npm test` chain | Remove deployGuard command from package.json | none | n/a | deployGuard.test.mjs, T1: AssertionError [ERR_ASSERTION]: npm test must run deployGuard.test.mjs |
| guard | escape flag | Parser sets ALLOW_UNMERGED=false instead of true | none | n/a | deployGuard.test.mjs, T8: AssertionError [ERR_ASSERTION]: HEAD e5b2cb9 is not contained in integration branch 'main'. |
| other | README deploy section documents the guard | Replace README refuses wording with proceeds | none | n/a | deployGuard.test.mjs, T1: AssertionError [ERR_ASSERTION]: The input did not match the regular expression /Deploy refuses before building or copying/. Input: |
| identifier | overridable with `AIOS_INTEGRATION_BRANCH` | integration -> main | none | n/a | deployGuard.test.mjs, T6: AssertionError [ERR_ASSERTION]: AIOS_INTEGRATION_BRANCH must select integration, not main: HEAD 4f46eef is not contained in integration branch 'main'. |

REQ-9's row tests the escape flag; the other required guards have separate rows. In addition to failure assertions, successful fixtures assert named plugin and exporter destination paths and exact stub npm arguments. The only normalization in recorded assertion evidence replaces the checkout prefix with `<checkout>` to keep personal filesystem paths out of this public repository.

## Proof-table gate

The shared `check-proof-table.mjs` was run against this report with `--brief` pointing to the task brief. Exit 0:

```text
proof table OK (1 tables)
```

## Refusal text

An actual clean, unmerged fixture run exited 1 and printed the following. Only the command's private checkout prefix is normalized; its full SHA and shell escaping are retained:

```text
HEAD 7fd44f1 is not contained in integration branch 'main'.
Fast-forward command: git -C <checkout>/.deploy-guard-6GX3mb/integration\ worktree merge --ff-only 7fd44f1810dd742cfe67287958cc80b46f7b5a66
Refusing deploy. Fast-forward the integration branch and commit changes, or use --allow-unmerged for a deliberate preview.
```

The command is a tested real merge in the worktree already holding the integration branch, never a force-update of a checked-out branch. If the branch has no worktree, the printed command checks it out in the deploying repository then merges the full SHA with `--ff-only`. It cannot resolve divergent history by fast-forward, and will safely refuse in that case.

Missing branch:

```text
Refusing deploy: local integration branch '<branch>' does not exist (HEAD <short-sha>).
```

Dirty tree:

```text
WARNING: dirty working tree; uncommitted changes would be deployed but are in no branch.
Refusing deploy. Fast-forward the integration branch and commit changes, or use --allow-unmerged for a deliberate preview.
```
