import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const cases = [
  ['ancestry', 'deploy.sh', 'if ! git merge-base --is-ancestor HEAD "refs/heads/$INTEGRATION_BRANCH"; then', 'if false; then', 'unmerged side branch'],
  ['default branch', 'deploy.sh', '${AIOS_INTEGRATION_BRANCH:-main}', '${AIOS_INTEGRATION_BRANCH:-integration}', 'HEAD in integration branch'],
  ['repair command', 'deploy.sh', "printf 'git -C %q merge --ff-only %q\\n'", "printf 'git -C %q merge --invalid-option %q\\n'", 'unmerged side branch'],
  ['missing branch', 'deploy.sh', 'if ! git show-ref --verify --quiet "refs/heads/$INTEGRATION_BRANCH"; then', 'if false; then', 'missing local integration branch'],
  ['preview reminders', 'deploy.sh', 'preview_reminder\nDST=', ':\nDST=', '--allow-unmerged permits'],
  ['dirty tree', 'deploy.sh', 'if [[ -n "$(git status --porcelain)" ]]; then', 'if false; then', 'dirty tree refuses'],
  ['artifact copy', 'deploy.sh', 'cp main.js manifest.json styles.css "$DST/"', 'cp main.js manifest.json "$DST/"', 'HEAD in integration branch'],
  ['test chain', 'package.json', 'node deployGuard.test.mjs && ', '', 'deploy documentation'],
  ['escape flag', 'deploy.sh', '--allow-unmerged) ALLOW_UNMERGED=true ;;', '--allow-unmerged) ALLOW_UNMERGED=false ;;', '--allow-unmerged permits'],
  ['README', 'README.md', 'Deploy refuses before building or copying', 'Deploy proceeds before building or copying', 'deploy documentation'],
  ['env override', 'deploy.sh', 'INTEGRATION_BRANCH="${AIOS_INTEGRATION_BRANCH:-main}"', 'INTEGRATION_BRANCH="main"', 'AIOS_INTEGRATION_BRANCH override'],
];
const results = [];
for (const [name, file, from, to, filter] of cases) {
  const original = readFileSync(file, 'utf8');
  if (original.split(from).length !== 2) throw new Error(`nonunique mutation: ${name}`);
  let mutated = original.replace(from, to);
  // Ancestry could mask a missing-branch bypass. Disable it too for differential proof.
  if (name === 'missing branch') mutated = mutated.replace('if ! git merge-base --is-ancestor HEAD "refs/heads/$INTEGRATION_BRANCH"; then', 'if false; then');
  try {
    writeFileSync(file, mutated);
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', `--test-name-pattern=${filter}`, 'deployGuard.test.mjs'], { encoding: 'utf8', timeout: 30_000 });
    const output = result.stdout + result.stderr;
    if (result.status === 0 || result.error) throw new Error(`mutation survived: ${name}: ${output}`);
    const lines = output.split('\n');
    const failure = lines.find(l => l.includes('✖') && !l.includes('failing tests'));
    const assertion = lines.find(l => l.includes('AssertionError') || l.includes('Error: ENOENT'));
    if (!failure || !assertion) throw new Error(`missing literal evidence: ${output}`);
    results.push({ name, failure: failure.trim(), assertion: assertion.trim().replaceAll(process.cwd(), '<checkout>') });
    console.log(`MUTATION ${name}: ${failure.trim()}\n${assertion.trim()}`);
  } finally {
    writeFileSync(file, original);
  }
  const green = spawnSync(process.execPath, ['--test', `--test-name-pattern=${filter}`, 'deployGuard.test.mjs'], { encoding: 'utf8', timeout: 30_000 });
  if (green.status !== 0) throw new Error(`restore failed: ${name}: ${green.stdout}${green.stderr}`);
  console.log(`RESTORED ${name}: PASS`);
}
writeFileSync('Projects/aios-dashboard/2026-10-05-deploy-guard-mutation-results.json', JSON.stringify(results, null, 2) + '\n');
