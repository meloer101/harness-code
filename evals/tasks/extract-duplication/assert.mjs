import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/format.js', 'utf8');

// The whitespace-normalization step is the duplicated line; after extraction it
// should live in exactly one place.
const norm = (src.match(/replace\(\/\\s\+\/g/g) ?? []).length;
if (norm > 1) {
  console.error(`whitespace normalization still duplicated (${norm} occurrences)`);
  process.exit(1);
}
// And there should now be a third function (the helper) beyond the two exports.
const fns = (src.match(/function\s+\w+/g) ?? []).length;
if (fns < 3) {
  console.error(`expected a shared helper function (found ${fns} functions)`);
  process.exit(1);
}

try {
  execFileSync('node', ['--test'], { stdio: 'inherit' });
} catch {
  process.exit(1);
}
