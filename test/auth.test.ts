// Bearer-auth gate for /admin/* routes (PR-L). Pure check: header vs configured token.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bearerAuthState } from '../src/api/auth.js';

const TOKEN = 'a-sufficiently-long-admin-token';

test('bearerAuthState — matching bearer token authorizes', () => {
  assert.equal(bearerAuthState(`Bearer ${TOKEN}`, TOKEN), 'ok');
});

test('bearerAuthState — wrong token is unauthorized', () => {
  assert.equal(bearerAuthState('Bearer nope', TOKEN), 'unauthorized');
});

test('bearerAuthState — same-length wrong token is unauthorized', () => {
  const wrong = TOKEN.slice(0, -1) + 'X';
  assert.equal(bearerAuthState(`Bearer ${wrong}`, TOKEN), 'unauthorized');
});

test('bearerAuthState — missing header is unauthorized', () => {
  assert.equal(bearerAuthState(undefined, TOKEN), 'unauthorized');
});

test('bearerAuthState — non-bearer scheme is unauthorized', () => {
  assert.equal(bearerAuthState(`Basic ${TOKEN}`, TOKEN), 'unauthorized');
});

test('bearerAuthState — unconfigured token fails closed, even with a matching guess', () => {
  assert.equal(bearerAuthState('Bearer anything', undefined), 'unconfigured');
  assert.equal(bearerAuthState('Bearer ', ''), 'unconfigured');
});
