#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const workspaceRoot = path.resolve(__dirname, '..', '..');
const agenticDir = path.join(workspaceRoot, '.agentic');
const buildLogPath = path.join(agenticDir, '__build.log');

console.log('[ralph:build] Running build verification...');

const isWindows = process.platform === 'win32';
const pnpmCmd = 'pnpm';

// Fallback to npx tsc if pnpm build is not yet wired
const result = spawnSync(pnpmCmd, ['build'], {
  cwd: workspaceRoot,
  encoding: 'utf-8',
  shell: isWindows,
});

if (result.status !== 0) {
  const output = (result.stdout || '') + '\n' + (result.stderr || '');
  console.error('[ralph:build] Build failed:');
  console.error(output);
  if (!fs.existsSync(agenticDir)) {
    fs.mkdirSync(agenticDir, { recursive: true });
  }
  fs.writeFileSync(buildLogPath, output, 'utf-8');
  process.exit(result.status ?? 1);
}

// Build succeeded - clean log if present
if (fs.existsSync(buildLogPath)) {
  fs.unlinkSync(buildLogPath);
}

console.log('[ralph:build] Build check passed successfully.');
process.exit(0);
