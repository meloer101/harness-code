import test from 'node:test';
import assert from 'node:assert/strict';

import { slugify } from '../src/slug.js';

test('lowercases and hyphenates words', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('strips punctuation, keeping letters and digits', () => {
  assert.equal(slugify('Node.js: The Good Parts!'), 'nodejs-the-good-parts');
});

test('collapses whitespace and trims', () => {
  assert.equal(slugify('  many   spaces  '), 'many-spaces');
});

test('keeps digits', () => {
  assert.equal(slugify('Top 10 Tips'), 'top-10-tips');
});
