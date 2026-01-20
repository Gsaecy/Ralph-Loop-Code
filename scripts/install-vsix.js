/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function findNewestVsix(cwd) {
  const entries = fs.readdirSync(cwd);
  const vsixFiles = entries
    .filter((name) => name.toLowerCase().endsWith('.vsix'))
    .map((name) => {
      const fullPath = path.join(cwd, name);
      const stat = fs.statSync(fullPath);
      return { name, fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return vsixFiles[0] ?? null;
}

function main() {
  const cwd = process.cwd();
  const newest = findNewestVsix(cwd);

  if (!newest) {
    console.error('No .vsix found in current directory. Run `npm run package` first.');
    process.exit(1);
  }

  const result = spawnSync('code', ['--install-extension', newest.fullPath], {
    stdio: 'inherit',
    shell: true,
  });

  process.exit(result.status ?? 1);
}

main();
