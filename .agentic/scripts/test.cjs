#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const workspaceRoot = path.resolve(__dirname, '..', '..');
const agenticDir = path.join(workspaceRoot, '.agentic');
const testLogPath = path.join(agenticDir, '__test.log');
const coverageJsonPath = path.join(agenticDir, 'coverage.json');
const coverageSummaryPath = path.join(workspaceRoot, 'coverage', 'coverage-summary.json');
const metrics = ['lines', 'statements', 'functions', 'branches'];

function writeLog(message) {
  fs.mkdirSync(agenticDir, { recursive: true });
  fs.writeFileSync(testLogPath, message, 'utf8');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function coverageFromSummary(summary) {
  const total = summary?.total;
  if (!total || metrics.some((metric) => typeof total[metric]?.pct !== 'number')) {
    return null;
  }
  return Object.fromEntries(metrics.map((metric) => [metric, total[metric].pct]));
}

console.log('[ralph:test] Running test suite & coverage analysis...');
const result = spawnSync('pnpm', ['test:coverage'], {
  cwd: workspaceRoot,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
const output = `${result.stdout || ''}\n${result.stderr || ''}`;

if (result.status !== 0) {
  console.error('[ralph:test] Test run failed:');
  console.error(output);
  writeLog(output);
  process.exit(result.status ?? 1);
}

const currentCoverage = coverageFromSummary(readJson(coverageSummaryPath));
if (!currentCoverage) {
  const message = '[ralph:coverage] Coverage summary missing or invalid.';
  console.error(message);
  writeLog(`${output}\n\n${message}`);
  process.exit(1);
}

const previousCoverage = readJson(coverageJsonPath);
const regressions = metrics
  .filter(
    (metric) =>
      typeof previousCoverage?.[metric] === 'number' &&
      currentCoverage[metric] < previousCoverage[metric],
  )
  .map(
    (metric) =>
      `${metric} coverage dropped from ${previousCoverage[metric]}% to ${currentCoverage[metric]}%`,
  );

if (regressions.length > 0) {
  const message = `[ralph:coverage] Coverage regression detected:\n${regressions.join('\n')}`;
  console.error(message);
  writeLog(`${output}\n\n${message}`);
  process.exit(1);
}

fs.mkdirSync(agenticDir, { recursive: true });
fs.writeFileSync(
  coverageJsonPath,
  `${JSON.stringify({ ...currentCoverage, timestamp: new Date().toISOString() }, null, 2)}\n`,
  'utf8',
);
if (fs.existsSync(testLogPath)) fs.unlinkSync(testLogPath);
console.log(
  `[ralph:coverage] Coverage lines: ${currentCoverage.lines}%, branches: ${currentCoverage.branches}%`,
);
console.log('[ralph:test] All tests and coverage checks passed successfully.');
process.exit(0);
