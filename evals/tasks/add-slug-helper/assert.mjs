import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

if (readFileSync('src/slug.js', 'utf8').includes("throw new Error('not implemented')")) {
  console.error('slugify is still the stub');
  process.exit(1);
}

try {
  execFileSync('node', ['--test'], { stdio: 'inherit' });
} catch {
  process.exit(1);
}
