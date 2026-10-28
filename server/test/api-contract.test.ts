import assert from 'node:assert/strict';
import test from 'node:test';
import { matchDeclaredApiChange, repoMatchesField, type CorpusTarget } from '../src/lib/api-contract.js';

const pool: CorpusTarget[] = [
  { repoId: 'web', repoName: 'shop-web' },
  { repoId: 'api', repoName: 'shop-api' },
];

test('repoMatchesField understands names, paths and Chinese separators', () => {
  assert.equal(repoMatchesField('shop-api', 'shop-api'), true);
  assert.equal(repoMatchesField('shop-api, shop-web', 'shop-web'), true);
  assert.equal(repoMatchesField('/repos/shop-api', 'shop-api'), true);
  assert.equal(repoMatchesField('shop-api、shop-web', 'shop-web'), true);
  assert.equal(repoMatchesField('other', 'shop-web'), false);
  assert.equal(repoMatchesField(undefined, 'shop-web'), false);
  assert.equal(repoMatchesField('', 'shop-web'), false);
});

test('a declared endpoint must be implemented in the repo it belongs to', () => {
  const corpus = new Map<string, string>([
    ['web', "axios.post('/api/orders/batch-cancel')"],
    ['api', "router.post('/orders/batch-cancel', handler)"],
  ]);
  const change = { method: 'POST', path: '/api/orders/batch-cancel', repo: 'shop-api' };

  const hit = matchDeclaredApiChange(corpus, change, [pool[1]]);
  assert.equal(hit?.repoId, 'api');
  assert.match(hit?.matched ?? '', /orders/);

  // The frontend's call site must not satisfy a change that is explicitly
  // declared as belonging to the backend repo: each repo has its own corpus.
  const frontendOnly = new Map([['web', corpus.get('web')!]]);
  assert.equal(matchDeclaredApiChange(frontendOnly, change, [pool[1]]), null);
  assert.equal(matchDeclaredApiChange(new Map([['api', "router.get('/health', h)"]]), change, [pool[1]]), null);
});

test('matching tolerates API prefixes and path parameters', () => {
  const corpus = new Map([['api', "app.get('/users/:id/profile', show)"]]);
  const hit = matchDeclaredApiChange(corpus, { method: 'GET', path: '/api/users/${id}/profile' }, [pool[1]]);
  assert.ok(hit);
  assert.equal(hit?.repoId, 'api');
});

test('missing implementations are reported as no match', () => {
  const corpus = new Map([
    ['web', 'fetch("/api/health")'],
    ['api', "router.get('/health', h)"],
  ]);
  assert.equal(matchDeclaredApiChange(corpus, { method: 'DELETE', path: '/api/orders/42' }, pool), null);
  // too-short tails must not match arbitrary text
  assert.equal(matchDeclaredApiChange(corpus, { method: 'GET', path: '/api/u' }, pool), null);
});
