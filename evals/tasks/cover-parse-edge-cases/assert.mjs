import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// src/ is not the thing under test here — it must be left alone.
const src = readFileSync('src/parseRange.js', 'utf8');
if (!src.includes('inverted range') || !src.includes('range too wide')) {
  console.error('src/parseRange.js was changed');
  process.exit(1);
}

const spec = readFileSync('test/parseRange.test.mjs', 'utf8');
if (!spec.includes("parseRange('3-7')")) {
  console.error('the original test was removed');
  process.exit(1);
}
const throws = (spec.match(/assert\.throws|assert\.rejects|\.throws\(/g) ?? []).length;
if (throws < 3) {
  console.error(`expected at least 3 error-path assertions, found ${throws}`);
  process.exit(1);
}

try {
  execFileSync('node', ['--test'], { stdio: 'inherit' });
} catch {
  process.exit(1);
}
