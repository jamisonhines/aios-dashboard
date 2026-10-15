import './testFileTimeout.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';

// Files under test (deploy.sh, package.json, README.md) are read from DEPLOY_GUARD_SRC when set.
// The opt-in mutation suite points it at a temp copy so the tracked files are never written.
const srcDir = process.env.DEPLOY_GUARD_SRC ? pathToFileURL(join(process.env.DEPLOY_GUARD_SRC, '/')) : new URL('./', import.meta.url);
const script = readFileSync(new URL('deploy.sh', srcDir));

// Fixtures live under os.tmpdir(), never in the checkout. They are removed on pass, on failure
// and on SIGINT/SIGTERM. DEPLOY_GUARD_KEEP_FIXTURES=1 keeps them for inspection (default off).
const keepFixtures = process.env.DEPLOY_GUARD_KEEP_FIXTURES === '1';
const fixtureRoots = [];
function removeFixtures() {
  for (const dir of fixtureRoots.splice(0)) {
    if (keepFixtures) { process.stderr.write(`kept fixture: ${dir}\n`); continue; }
    rmSync(dir, { recursive: true, force: true });
  }
}
process.on('exit', removeFixtures);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(1));
after(removeFixtures);

// Fixture git calls and deploy.sh spawns must never see the caller's GIT_DIR, GIT_WORK_TREE,
// GIT_INDEX_FILE etc. (set when tests run from a git hook), or they would write to that repo.
const cleanEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  ...extra,
});

function fixture(branch = 'main') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deploy-guard-')));
  fixtureRoots.push(root);
  const repo = join(root, 'side repo');
  const vault = join(root, 'target');
  const bin = join(root, 'bin');
  mkdirSync(repo); mkdirSync(vault); mkdirSync(bin);
  writeFileSync(join(vault, 'sentinel'), 'untouched');
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', branch); git('config', 'user.name', 'Test Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repo, 'deploy.sh'), script, { mode: 0o755 });
  for (const name of ['main.js', 'manifest.json', 'styles.css']) writeFileSync(join(repo, name), name);
  mkdirSync(join(repo, 'vault-scripts'));
  writeFileSync(join(repo, 'vault-scripts/export.mjs'), 'export fixture');
  git('add', '.'); git('commit', '-m', 'Fixture baseline');
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$*" > build-called\necho "stub build"\n', { mode: 0o755 });
  const run = (args = [vault], env = {}) => spawnSync('bash', ['deploy.sh', ...args], {
    cwd: repo, encoding: 'utf8', timeout: 10_000,
    env: cleanEnv({ AIOS_INTEGRATION_BRANCH: '', PATH: `${bin}:${process.env.PATH}`, ...env }),
  });
  const side = () => {
    git('switch', '-c', 'side');
    const holding = join(root, 'integration worktree');
    git('worktree', 'add', holding, branch);
    writeFileSync(join(repo, 'feature'), 'side feature'); git('add', 'feature'); git('commit', '-m', 'Side feature');
    return holding;
  };
  const untouched = () => {
    assert.deepEqual(readdirSync(vault), ['sentinel'], 'target must remain untouched');
    assert.equal(existsSync(join(repo, 'build-called')), false, 'build must not run');
  };
  const deployed = (r) => {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(repo, 'build-called'), 'utf8'), 'run build\n');
    for (const name of ['main.js', 'manifest.json', 'styles.css']) assert.equal(readFileSync(join(vault, '.obsidian/plugins/aios-dashboard', name), 'utf8'), name);
    assert.equal(readFileSync(join(vault, 'Operations/scripts/export.mjs'), 'utf8'), 'export fixture');
    assert.equal(r.stdout, `stub build\ndeployed to ${vault}/.obsidian/plugins/aios-dashboard\ndeployed vault scripts to ${vault}/Operations/scripts\n`);
  };
  return { root, repo, vault, git, run, side, untouched, deployed };
}

test('deploy documentation and test-chain contract', () => {
  const pkg = JSON.parse(readFileSync(new URL('package.json', srcDir), 'utf8'));
  assert.ok(pkg.scripts.test.split(' && ').includes('node deployGuard.test.mjs'), 'npm test must run deployGuard.test.mjs');
  assert.ok(readFileSync(new URL('./deployGuard.test.mjs', import.meta.url), 'utf8').includes("import './testFileTimeout.mjs';"), 'deploy guard tests must load hard timeout');
  const readme = readFileSync(new URL('README.md', srcDir), 'utf8');
  assert.match(readme, /Deploy refuses before building or copying/);
  assert.match(readme, /AIOS_INTEGRATION_BRANCH=<branch>/);
  assert.match(readme, /--allow-unmerged/);
});

test('HEAD in integration branch deploys unchanged artifacts and output', () => {
  const f = fixture(); f.deployed(f.run());
});
test('HEAD behind integration branch is contained and deploys', () => {
  const f = fixture(); f.git('branch', 'older');
  writeFileSync(join(f.repo, 'future'), 'future'); f.git('add', '.'); f.git('commit', '-m', 'Integration advances');
  f.git('switch', 'older'); f.deployed(f.run());
});
test('untracked files refuse before build or copy', () => {
  const f = fixture(); writeFileSync(join(f.repo, 'untracked'), 'not committed');
  const r = f.run(); assert.notEqual(r.status, 0);
  assert.match(r.stderr, /WARNING: dirty working tree/); f.untouched();
});
test('untracked deploy content refuses even when status.showUntrackedFiles is no', () => {
  const f = fixture(); f.git('config', 'status.showUntrackedFiles', 'no');
  writeFileSync(join(f.repo, 'vault-scripts/evil.mjs'), 'export untracked');
  assert.equal(f.git('status', '--porcelain'), '', 'fixture config must hide untracked files from plain status');
  const r = f.run(); assert.notEqual(r.status, 0, 'untracked vault script must refuse');
  assert.match(r.stderr, /WARNING: dirty working tree/); f.untouched();
});
test('unmerged side branch refuses before build or copy; printed command fast-forwards occupied worktree', () => {
  const f = fixture(); const holding = f.side(); const r = f.run();
  assert.notEqual(r.status, 0, 'unmerged HEAD must refuse');
  assert.ok(r.stderr.includes(`HEAD ${f.git('rev-parse', '--short', 'HEAD')} is not contained in integration branch 'main'.`), 'refusal must name current HEAD and main');
  f.untouched();
  const command = r.stderr.match(/^Fast-forward command: (.+)$/m)?.[1];
  assert.ok(command, 'exact fast-forward command must be printed');
  const fixed = spawnSync('bash', ['-c', command], { cwd: f.repo, env: cleanEnv(), encoding: 'utf8', timeout: 10_000 });
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(execFileSync('git', ['-C', holding, 'rev-parse', 'HEAD'], { env: cleanEnv(), encoding: 'utf8' }).trim(), f.git('rev-parse', 'HEAD'));
  f.deployed(f.run());
});
test('integration branch checked out nowhere prints checkout + ff command that works', () => {
  const f = fixture(); const holding = f.side();
  f.git('worktree', 'remove', holding);
  const r = f.run(); assert.notEqual(r.status, 0, 'unmerged HEAD must refuse');
  f.untouched();
  const command = r.stderr.match(/^Fast-forward command: (.+)$/m)?.[1];
  assert.ok(command, 'exact fast-forward command must be printed');
  assert.match(command, / checkout main && git -C .* merge --ff-only /);
  const fixed = spawnSync('bash', ['-c', command], { cwd: f.repo, env: cleanEnv(), encoding: 'utf8', timeout: 10_000 });
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(f.git('rev-parse', 'main'), f.git('rev-parse', 'HEAD'));
  f.deployed(f.run());
});
test('AIOS_INTEGRATION_BRANCH override uses named local integration branch', () => {
  const f = fixture('integration'); f.git('branch', 'main'); f.git('switch', '-c', 'feature');
  writeFileSync(join(f.repo, 'feature'), 'new'); f.git('add', '.'); f.git('commit', '-m', 'Feature');
  f.git('branch', '-f', 'integration', 'HEAD');
  const r = f.run([f.vault], { AIOS_INTEGRATION_BRANCH: 'integration' });
  assert.equal(r.status, 0, `AIOS_INTEGRATION_BRANCH must select integration, not main: ${r.stderr}`);
  f.deployed(r);
});
test('missing local integration branch refuses clearly even with preview flag', () => {
  const f = fixture('other'); const r = f.run(['--allow-unmerged', f.vault]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Refusing deploy: local integration branch 'main' does not exist/);
  f.untouched();
});
test('--allow-unmerged permits preview in either position with reminders before and after copy', () => {
  for (const first of [true, false]) {
    const f = fixture(); f.side();
    const r = f.run(first ? ['--allow-unmerged', f.vault] : [f.vault, '--allow-unmerged']); f.deployed(r);
    const reminder = `WARNING: PREVIEW ONLY: HEAD ${f.git('rev-parse', '--short', 'HEAD')} is not in integration branch 'main'; it MUST be merged this session.`;
    assert.equal(r.stderr.split(reminder).length - 1, 2, 'preview reminder must appear twice');
    // One combined stream proves the warning brackets both copy output lines.
    const combined = spawnSync('bash', ['-c', 'bash deploy.sh --allow-unmerged "$1" 2>&1', 'test', f.vault], {
      cwd: f.repo, encoding: 'utf8', timeout: 10_000,
      env: cleanEnv({ AIOS_INTEGRATION_BRANCH: '', PATH: `${join(f.root, 'bin')}:${process.env.PATH}` }),
    }).stdout;
    assert.ok(combined.indexOf(reminder) < combined.indexOf('stub build'));
    assert.ok(combined.lastIndexOf(reminder) > combined.indexOf('deployed vault scripts to'));
  }
});
test('dirty tree refuses with warning; preview permits dirty changes with two reminders', () => {
  const f = fixture(); writeFileSync(join(f.repo, 'main.js'), 'dirty content');
  const r = f.run(); assert.notEqual(r.status, 0, 'dirty tree must refuse');
  assert.match(r.stderr, /WARNING: dirty working tree; uncommitted changes would be deployed but are in no branch/); f.untouched();
  const preview = f.run([f.vault, '--allow-unmerged']); assert.equal(preview.status, 0, preview.stderr);
  assert.equal(readFileSync(join(f.vault, '.obsidian/plugins/aios-dashboard/main.js'), 'utf8'), 'dirty content');
  assert.equal(preview.stderr.split('WARNING: PREVIEW ONLY: dirty changes').length - 1, 2);
});
test('vault path required and invalid arguments refuse before build', () => {
  const f = fixture();
  for (const args of [[], ['--allow-unmerged'], [f.vault, 'extra'], ['--unknown', f.vault]]) {
    const r = f.run(args); assert.notEqual(r.status, 0); assert.match(r.stderr, /usage:/); f.untouched();
  }
});
