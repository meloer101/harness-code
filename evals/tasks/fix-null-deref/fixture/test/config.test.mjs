import test from 'node:test';
import assert from 'node:assert/strict';

import { getPort } from '../src/config.js';

test('returns the configured port', () => {
  assert.equal(getPort({ server: { port: 8080 } }), 8080);
});

test('falls back to 3000 when the server section is missing', () => {
  assert.equal(getPort({}), 3000);
});

test('falls back to 3000 when the whole config is empty', () => {
  assert.equal(getPort({ server: {} }), 3000);
});
