import './testFileTimeout.mjs';
// Opt-in mutation-proof suite for deployGuard.test.mjs. NOT part of `npm test`;
// run with `npm run test:mutations` or `node deployGuard.mutations.test.mjs`.
//
// Safety: every mutation is applied to a COPY of deploy.sh / package.json / README.md in a fresh
// temp directory, and deployGuard.test.mjs is pointed at that copy via DEPLOY_GUARD_SRC. The
// tracked files are only ever read, so a kill mid-run cannot leave them mutated. Nothing is
// written into the repo; results are printed to stdout.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = ['deploy.sh', 'package.json', 'README.md'];
const repoDir = fileURLToPath(new URL('./', import.meta.url));
const here = (name) => new URL(`./${name}`, import.meta.url);
const ANCESTRY = 'if ! git merge-base --is-ancestor HEAD "refs/heads/$INTEGRATION_BRANCH"; then';
const TIP_CHECK = 'if [[ "$UNMERGED" == false && "$(git rev-parse HEAD)" != "$INTEGRATION_TIP" ]]; then';
const TIP_LOOKUP = 'INTEGRATION_TIP=$(git rev-parse "refs/heads/$INTEGRATION_BRANCH")';

const cases = [
  ['ancestry', 'deploy.sh', ANCESTRY, 'if false; then', 'unmerged side branch'],
  ['default branch', 'deploy.sh', '${AIOS_INTEGRATION_BRANCH:-main}', '${AIOS_INTEGRATION_BRANCH:-integration}', 'HEAD in integration branch'],
  ['repair command', 'deploy.sh', "printf 'git -C %q merge --ff-only %q\\n'", "printf 'git -C %q merge --invalid-option %q\\n'", 'unmerged side branch'],
  ['missing branch', 'deploy.sh', 'if ! git show-ref --verify --quiet "refs/heads/$INTEGRATION_BRANCH"; then', 'if false; then', 'missing local integration branch'],
  ['preview reminders', 'deploy.sh', 'preview_reminder\nDST=', ':\nDST=', '--allow-unmerged permits'],
  ['dirty tree', 'deploy.sh', 'if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then', 'if false; then', 'dirty tree refuses'],
  ['artifact copy', 'deploy.sh', 'cp main.js manifest.json styles.css "$DST/"', 'cp main.js manifest.json "$DST/"', 'HEAD in integration branch'],
  ['test chain', 'package.json', 'node deployGuard.test.mjs && ', '', 'deploy documentation'],
  ['escape flag', 'deploy.sh', '--allow-unmerged) ALLOW_UNMERGED=true ;;', '--allow-unmerged) ALLOW_UNMERGED=false ;;', '--allow-unmerged permits'],
  ['README', 'README.md', 'Deploy refuses before building or copying', 'Deploy proceeds before building or copying', 'deploy documentation'],
  ['untracked flag', 'deploy.sh', ' --untracked-files=normal', '', 'status.showUntrackedFiles is no'],
  ['unoccupied ff cmd', 'deploy.sh', "printf 'git -C %q checkout %q && git -C %q merge --ff-only %q\\n'", "printf 'git -C %q checkout %q && git -C %q merge --bogus %q\\n'", 'checked out nowhere'],
  ['env override', 'deploy.sh', 'INTEGRATION_BRANCH="${AIOS_INTEGRATION_BRANCH:-main}"', 'INTEGRATION_BRANCH="main"', 'AIOS_INTEGRATION_BRANCH override'],
  ['tip check removed', 'deploy.sh', TIP_CHECK, 'if false; then', 'behind integration tip refuses'],
  ['tip wrong ref HEAD', 'deploy.sh', TIP_LOOKUP, 'INTEGRATION_TIP=$(git rev-parse HEAD)', 'behind integration tip refuses'],
  ['tip wrong ref main', 'deploy.sh', TIP_LOOKUP, 'INTEGRATION_TIP=$(git rev-parse refs/heads/main)', 'AIOS_INTEGRATION_BRANCH override'],
  ['rollback reminder', 'deploy.sh', 'echo "WARNING: ROLLBACK:', ': "WARNING: ROLLBACK:', 'behind integration tip with --allow-unmerged'],
  ['unoccupied ff target', 'deploy.sh', '"$(git rev-parse --show-toplevel)" "$(git rev-parse HEAD)" >&2', '"$(git rev-parse --show-toplevel)" "$INTEGRATION_BRANCH" >&2', 'checked out nowhere'],
];

const runTests = (srcDir, filter, reporter) => spawnSync(
  process.execPath,
  ['--test', ...(reporter ? [`--test-reporter=${reporter}`] : []), `--test-name-pattern=${filter}`, 'deployGuard.test.mjs'],
  { cwd: repoDir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, DEPLOY_GUARD_SRC: srcDir } },
);

const originals = Object.fromEntries(FILES.map((f) => [f, readFileSync(here(f), 'utf8')]));
const tmpRoots = [];
const cleanup = () => { for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true }); };
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(1));

const results = [];
for (const [name, file, from, to, filter] of cases) {
  const original = originals[file];
  if (original.split(from).length !== 2) throw new Error(`nonunique or missing mutation target: ${name}`);
  let mutated = original.replace(from, to);
  // Ancestry and the tip lookup could mask a missing-branch bypass. Disable both for differential proof.
  if (name === 'missing branch') mutated = mutated.replace(ANCESTRY, 'if false; then').replace(TIP_LOOKUP, 'INTEGRATION_TIP=$(git rev-parse HEAD)');
  // With ancestry gone, a side commit reads as behind the tip. Disable the tip check too.
  if (name === 'ancestry') mutated = mutated.replace(TIP_CHECK, 'if false; then');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'deploy-guard-mutation-')));
  tmpRoots.push(dir);
  for (const f of FILES) writeFileSync(join(dir, f), f === file ? mutated : originals[f]);

  const red = runTests(dir, filter, 'spec');
  const output = red.stdout + red.stderr;
  if (red.status === 0 || red.error) throw new Error(`mutation survived: ${name}: ${output}`);
  const lines = output.split('\n');
  const failure = lines.find((l) => l.includes('✖') && !l.includes('failing tests'));
  const assertion = lines.find((l) => l.includes('AssertionError') || l.includes('Error: ENOENT'));
  if (!failure || !assertion) throw new Error(`missing literal evidence: ${output}`);
  results.push({ name, failure: failure.trim(), assertion: assertion.trim() });
  console.log(`MUTATION ${name}: ${failure.trim()}\n${assertion.trim()}`);

  // Restore check: the same filter against the unmutated tracked files must be green.
  const green = runTests(repoDir, filter);
  if (green.status !== 0) throw new Error(`restore failed: ${name}: ${green.stdout}${green.stderr}`);
  console.log(`RESTORED ${name}: PASS`);
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${results.length}/${cases.length} mutations red, all restored green`);
console.log(JSON.stringify(results, null, 2));
