#!/usr/bin/env node
const { spawnSync } = require('node:child_process');

const workspaceRoot = require('node:path').resolve(__dirname, '..', '..');
const result = spawnSync('jj', ['diff', '--summary'], {
  cwd: workspaceRoot,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
if (result.status !== 0) {
  console.error('[ralph:commit] Could not inspect jj working copy.');
  console.error(output);
  process.exit(result.status ?? 1);
}

if (output.length > 0) {
  console.error('[ralph:commit] Working copy has uncommitted changes.');
  console.error(output);
  process.exit(1);
}

console.log('[ralph:commit] jj working copy is clean.');
