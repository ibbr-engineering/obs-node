import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = mkdtempSync(join(tmpdir(), 'obs-node-git-install-'));
const taggedRepo = join(workspace, 'tagged-repo');
const consumer = join(workspace, 'consumer');

function run(command, args, cwd, env = process.env) {
  execFileSync(command, args, { cwd, env, stdio: 'inherit' });
}

try {
  cpSync(sourceRoot, taggedRepo, {
    recursive: true,
    filter(source) {
      const name = basename(source);
      return !['.git', 'node_modules', 'dist', 'dist-test'].includes(name) && !name.endsWith('.tgz');
    },
  });

  run('git', ['init', '-b', 'main'], taggedRepo);
  run('git', ['config', 'user.email', 'git-install@example.invalid'], taggedRepo);
  run('git', ['config', 'user.name', 'Git Install Test'], taggedRepo);
  run('git', ['add', '.'], taggedRepo);
  run('git', ['commit', '-m', 'test: create install fixture'], taggedRepo);
  run('git', ['tag', 'v0.1.0'], taggedRepo);

  mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, 'package.json'), '{"private":true}\n');
  cpSync(join(sourceRoot, 'test', 'consumer'), consumer, { recursive: true });

  const npmCache = join(workspace, 'npm-cache');
  const installEnv = { ...process.env, npm_config_cache: npmCache };
  const dependency = `git+${pathToFileURL(taggedRepo).href}#v0.1.0`;
  run('npm', ['install', dependency], consumer, installEnv);
  run(process.execPath, ['commonjs.cjs'], consumer);
  run(process.execPath, ['esm.mjs'], consumer);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
