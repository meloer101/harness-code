import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRange } from '../src/parseRange.js';

test('expands an inclusive range', () => {
  assert.deepEqual(parseRange('3-7'), [3, 4, 5, 6, 7]);
});
