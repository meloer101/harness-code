import test from 'node:test';
import assert from 'node:assert/strict';

import { formatUser, formatTeam } from '../src/format.js';

test('formats a user with initials', () => {
  assert.equal(formatUser({ name: '  Ada   Lovelace ' }), 'Ada Lovelace (AL)');
});

test('formats a team with initials', () => {
  assert.equal(formatTeam({ name: 'Rapid Response' }), 'Team Rapid Response [RR]');
});
