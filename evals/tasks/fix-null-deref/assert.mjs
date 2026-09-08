import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// The test files must be untouched.
const orig = `import test from 'node:test';`;
if (!readFileSync('test/config.test.mjs', 'utf8').includes(orig)) {
  console.error('test/config.test.mjs was modified');
  process.exit(1);
}

try {
  execFileSync('node', ['--test'], { stdio: 'inherit' });
} catch {
  process.exit(1);
}
