import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync, createVerify } from 'node:crypto';
import { policy, ceiling, hash, reserve, validateCI, parseResponse, eligible,
  requestBody, CI_PATH } from '../../scripts/reviewer/core.mjs';
import { GitHub, jsonRequest, writerToken } from '../../scripts/reviewer/github.mjs';
import { callReviewer, prepare, publish, gate } from '../../scripts/reviewer/run.mjs';

const H = 'a'.repeat(40), B = 'b'.repeat(40), T = 'c'.repeat(40);
const defaults = JSON.parse(await readFile(new URL('../../scripts/reviewer/policy.json', import.meta.url), 'utf8'));
const config = () => policy({ ...structuredClone(defaults), enabled: true, model: 'fixture-model',
  writerAppId: 123,
  maxReviews: 3, maxTotalMicroUsd: 1000000,
  inputMicroUsdPerMillionTokens: 1000000, outputMicroUsdPerMillionTokens: 2000000 });
const subject = () => ({ repository: defaults.repository, pr: 25, head: H, base: B, ciRunId: 100, ciAttempt: 1, reviewerSha: T });
const context = () => ({ subject: subject(), files: [{ path: 'src/example.ts', before: 'old\n', after: 'new\n' }] });
const freshLedger = () => ({ version: 1, paused: false, entries: [] });
const result = () => ({ verdict: 'pass', summary: 'No introduced defects found in supplied context.', limitations: [], findings: [] });
const response = (r = result()) => ({ id: 'resp_fixture', status: 'completed',
  output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(r) }] }],
  usage: { input_tokens: 1000, output_tokens: 100 } });
const fixturePR = () => ({ number: 25, state: 'open', changed_files: 1, title: 'Synthetic review', body: '',
  head: { sha: H, repo: { full_name: defaults.repository } },
  base: { sha: B, ref: 'main', repo: { full_name: defaults.repository } } });
const fixtureRun = () => ({ id: 100, head_sha: H, repository: { full_name: defaults.repository },
  head_repository: { full_name: defaults.repository }, event: 'pull_request', path: CI_PATH,
  status: 'completed', conclusion: 'success', run_attempt: 1,
  pull_requests: [{ number: 25, head: { sha: H }, base: { sha: B } }] });
const fixtureJobs = () => defaults.requiredJobs.map(name => ({ name, status: 'completed', conclusion: 'success' }));
const env = () => ({ GITHUB_SHA: T, GITHUB_RUN_ID: '200', GITHUB_RUN_ATTEMPT: '1', REVIEW_OPERATION: 'review' });

class FakeGitHub {
  p = config(); value = freshLedger(); revision = 0; writes = []; checks = []; context = context();
  pr = fixturePR(); run = fixtureRun(); jobs = fixtureJobs(); trustedSha = T;
  async call(path, options = {}) {
    if (path === '') return { default_branch: 'main' };
    if (path === '/git/ref/heads/main') return { object: { sha: this.trustedSha } };
    if (path === '/pulls/25') return this.pr;
    if (path === '/check-runs') { const id = this.checks.length + 1; this.checks.push({ id, app: { id: this.p.writerAppId }, ...options.body }); return { id }; }
    if (path.startsWith('/check-runs/')) {
      const check = this.checks.find(c => c.id === Number(path.split('/').at(-1)));
      Object.assign(check, options.body); return check;
    }
    throw Error(`Unexpected fixture call ${path}`);
  }
  async collect() { validateCI(this.run, this.jobs, this.pr, this.p); return structuredClone(this.context); }
  async evidence() { return { subject: validateCI(this.run, this.jobs, this.pr, this.p) }; }
  async tree() { return new Map([[CI_PATH, { sha: H }]]); }
  async currentPolicy() { return this.p; }
  async ledger() { return { sha: String(this.revision), value: structuredClone(this.value) }; }
  async saveLedger(s) {
    assert.equal(s.sha, String(this.revision), 'CAS conflict');
    this.value = structuredClone(s.value); this.revision++; this.writes.push(structuredClone(this.value));
  }
}

test('shipped policy disables paid execution and rejects unapproved configuration', () => {
  assert.equal(policy(defaults).enabled, false);
  assert.throws(() => policy({ ...defaults, enabled: true }), /model, rates/);
  assert.throws(() => policy({ ...defaults, allowMerge: true }), /fields/);
  for (const maxReviews of [-1, 101, 0.1]) assert.throws(() => policy({ ...defaults, maxReviews }));
});

test('reservations are candidate/base/policy bound, cumulative and never refunded', () => {
  const p = config(), ledger = freshLedger();
  const a = reserve(ledger, p, subject(), 200, hash(context()), T);
  assert.equal(a.entry.reservedMicroUsd, ceiling(p));
  assert.equal(reserve(ledger, p, subject(), 201, hash(context()), T).created, false);
  assert.equal(ledger.entries.length, 1);
  a.entry.status = 'blocked';
  const limited = { ...p, maxTotalMicroUsd: ceiling(p) };
  assert.throws(() => reserve(ledger, limited, { ...subject(), head: B }, 201, 'x', T), /budget/);
  ledger.paused = true;
  assert.throws(() => reserve(ledger, p, subject(), 201, 'x', T), /paused/);
});

for (const [name, mutate] of [
  ['old candidate', (pr, run) => { run.head_sha = T; }],
  ['new base', (pr) => { pr.base.sha = T; }],
  ['fork', (pr) => { pr.head.repo.full_name = 'other/atlas'; }],
  ['wrong workflow', (pr, run) => { run.path = 'impostor.yml'; }],
  ['push evidence', (pr, run) => { run.event = 'push'; }],
  ['skipped required job', (pr, run, jobs) => { jobs[0].conclusion = 'skipped'; }],
  ['missing required job', (pr, run, jobs) => { jobs.pop(); }],
  ['duplicate required job', (pr, run, jobs) => { jobs.push(jobs[0]); }],
]) test(`CI rejects ${name}`, () => {
  const pr = fixturePR(), run = fixtureRun(), jobs = fixtureJobs();
  mutate(pr, run, jobs); assert.throws(() => validateCI(run, jobs, pr, config()));
});

test('review result cannot override blockers, limitations or invent source locations', () => {
  const p = config(), c = context();
  assert.equal(parseResponse(response(), c, p).ok, true);
  const r = result(); r.findings.push({ priority: 1, path: 'src/example.ts', side: 'after', line: 1,
    title: 'Authorization missing', body: 'A caller can bypass the boundary.' });
  assert.equal(parseResponse(response(r), c, p).ok, false);
  r.findings[0].priority = 3;
  assert.equal(parseResponse(response(r), c, p).ok, true);
  r.limitations.push('Missing caller context');
  assert.equal(parseResponse(response(r), c, p).ok, false);
  r.findings[0].path = 'not-reviewed.ts';
  assert.throws(() => parseResponse(response(r), c, p), /outside/);
});

for (const [name, mutate] of [
  ['incomplete', r => { r.status = 'incomplete'; }],
  ['refusal', r => { r.output[0].content = [{ type: 'refusal', refusal: 'No' }]; }],
  ['tool invocation', r => { r.output.push({ type: 'function_call' }); }],
  ['missing usage', r => { delete r.usage; }],
  ['excess output', r => { r.usage.output_tokens = 999999; }],
  ['malformed JSON', r => { r.output[0].content[0].text = '{'; }],
]) test(`model output rejects ${name}`, () => {
  const r = response(); mutate(r); assert.throws(() => parseResponse(r, context(), config()));
});

test('provider counts identical input and makes one bounded generation with no tools', async () => {
  const calls = [];
  await callReviewer(config(), context(), 'fake-key', async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return Response.json(url.endsWith('/input_tokens') ? { input_tokens: 1000 } : response());
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body.input, calls[1].body.input);
  assert.deepEqual(calls[0].body.text, calls[1].body.text);
  assert.equal(calls[1].body.max_output_tokens, config().maxOutputTokens);
  assert.equal(calls[1].body.store, false);
  assert.equal(calls[1].body.truncation, 'disabled');
  assert.equal(calls[1].body.tools, undefined);
  assert.equal(calls[1].options.redirect, 'error');
});

test('input over cap never generates; uncertain generation is never retried', async () => {
  let calls = 0;
  await assert.rejects(callReviewer(config(), context(), 'fake', async () => {
    calls++; return Response.json({ input_tokens: 999999 });
  }), /token limit/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(callReviewer(config(), context(), 'fake', async () => {
    if (++calls === 1) return Response.json({ input_tokens: 1000 });
    throw Error('connection lost after provider accepted request');
  }), /connection lost/);
  assert.equal(calls, 2);
});

test('HTTP boundary limits response bodies, aborts and does not expose provider errors', async () => {
  await assert.rejects(jsonRequest('https://fixture', 'fake', { maxBytes: 10,
    fetcher: async () => Response.json({ long: 'x'.repeat(100) }) }), /size limit/);
  await assert.rejects(jsonRequest('https://fixture', 'fake', {
    fetcher: async () => new Response('secret-should-not-appear', { status: 429 }) }), /^Error: Remote request failed \(429\)$/);
  await assert.rejects(jsonRequest('https://fixture', 'fake', { timeoutMs: 10,
    fetcher: async (_, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Error('aborted')));
    }) }), /aborted/);
});

test('full prepare -> response -> durable receipt -> check -> gate journey', async () => {
  const gh = new FakeGitHub(), p = gh.p;
  const bundle = await prepare(gh, p, env(), { inputs: { pull_request: '25', ci_run_id: '100' } });
  assert.equal(bundle.dispatch, true);
  assert.equal(gh.writes[0].entries[0].status, 'reserved');
  assert.equal(await publish(gh, p, env(), bundle, response()), true);
  assert.equal(gh.value.entries[0].status, 'completed');
  assert.equal(gh.checks[0].conclusion, 'success');
  assert.equal((await gate(gh, p, 25)).candidate, H);
  const duplicate = await prepare(gh, p, { ...env(), GITHUB_RUN_ID: '201' },
    { inputs: { pull_request: '25', ci_run_id: '100' } });
  assert.equal(duplicate.dispatch, false);
  assert.equal(gh.value.entries.length, 1);
  gh.pr.head.sha = T;
  await assert.rejects(gate(gh, p, 25), /no eligible/);
});

test('publisher crash after durable receipt recovers without another model call', async () => {
  const gh = new FakeGitHub();
  const bundle = await prepare(gh, gh.p, env(), { inputs: { pull_request: '25', ci_run_id: '100' } });
  const call = gh.call.bind(gh); let killed = false;
  gh.call = async (path, options) => {
    if (path.startsWith('/check-runs/') && !killed) { killed = true; throw Error('publisher interrupted'); }
    return call(path, options);
  };
  await assert.rejects(publish(gh, gh.p, env(), bundle, response()), /interrupted/);
  assert.equal(gh.value.entries[0].status, 'completed');
  assert.equal(gh.checks[0].status, 'in_progress');
  const newDispatch = await prepare(gh, gh.p, { ...env(), GITHUB_RUN_ID: '201' },
    { inputs: { pull_request: '25', ci_run_id: '100' } });
  assert.equal(newDispatch.dispatch, false);
  assert.equal(gh.checks[0].conclusion, 'success');
  assert.equal((await gate(gh, gh.p, 25)).eligible, true);
  assert.equal(await publish(gh, gh.p, env(), bundle, undefined), true);
});

test('lost/invalid response, artifact tampering and stale evidence never pass', async () => {
  for (const mode of ['lost', 'tampered', 'base', 'attempt', 'pause']) {
    const gh = new FakeGitHub();
    const bundle = await prepare(gh, gh.p, env(), { inputs: { pull_request: '25', ci_run_id: '100' } });
    if (mode === 'tampered') bundle.context.files[0].after = 'forged';
    if (mode === 'base') gh.pr.base.sha = T;
    if (mode === 'attempt') gh.run.run_attempt++;
    if (mode === 'pause') gh.value.paused = true;
    if (mode === 'tampered') await assert.rejects(publish(gh, gh.p, env(), bundle, response()), /artifact/);
    else assert.equal(await publish(gh, gh.p, env(), bundle, mode === 'lost' ? undefined : response()), false);
    assert.notEqual(gh.checks[0].conclusion, 'success');
  }
});

test('concurrent prepare uses CAS so only one wake-up gets dispatch authority', async () => {
  const gh = new FakeGitHub();
  const outcomes = await Promise.allSettled([200, 201].map(id => prepare(gh, gh.p,
    { ...env(), GITHUB_RUN_ID: String(id) }, { inputs: { pull_request: '25', ci_run_id: '100' } })));
  assert.equal(outcomes.filter(x => x.status === 'fulfilled' && x.value.dispatch).length, 1);
  assert.equal(gh.value.entries.length, 1);
});

test('unresolved reservations and workflow reruns cannot buy another review', async () => {
  const gh = new FakeGitHub();
  await prepare(gh, gh.p, env(), { inputs: { pull_request: '25', ci_run_id: '100' } });
  const duplicate = await prepare(gh, gh.p, { ...env(), GITHUB_RUN_ID: '201' },
    { inputs: { pull_request: '25', ci_run_id: '100' } });
  assert.equal(duplicate.dispatch, false);
  assert.equal(gh.checks.at(-1).conclusion, 'failure');
  const other = new FakeGitHub();
  await assert.rejects(prepare(other, other.p, { ...env(), GITHUB_RUN_ATTEMPT: '2' },
    { inputs: { pull_request: '25', ci_run_id: '100' } }), /rerun/);
  assert.equal(other.value.entries.length, 0);
});

test('source fetch verifies actual Git blob hash and rejects binary/symlink/truncated trees', async () => {
  const content = 'safe source\n';
  const blobSha = createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex');
  const tree = new Map([['x.ts', { type: 'blob', mode: '100644', size: content.length, sha: blobSha }]]);
  const gh = new GitHub(defaults.repository, 'fake', async () => Response.json({ encoding: 'base64', content: Buffer.from(content).toString('base64') }));
  assert.equal(await gh.file(tree, 'x.ts', 100), content);
  tree.get('x.ts').mode = '120000'; await assert.rejects(gh.file(tree, 'x.ts', 100), /unsupported/);
  tree.get('x.ts').mode = '100644'; tree.get('x.ts').sha = H;
  await assert.rejects(gh.file(tree, 'x.ts', 100), /Corrupt/);
  gh.fetcher = async () => Response.json({ truncated: true, tree: [] });
  await assert.rejects(gh.tree(H), /incomplete/);
});

test('published gate rejects a spoofed check writer and changed reviewer revision', async () => {
  const gh = new FakeGitHub();
  const bundle = await prepare(gh, gh.p, env(), { inputs: { pull_request: '25', ci_run_id: '100' } });
  await publish(gh, gh.p, env(), bundle, response());
  gh.checks[0].app.id = 999;
  await assert.rejects(gate(gh, gh.p, 25), /provenance/);
  gh.checks[0].app.id = gh.p.writerAppId;
  gh.trustedSha = H;
  await assert.rejects(gate(gh, gh.p, 25), /no eligible/);
});

test('changed context and unresolved older reviewer revision cannot silently resubmit', async () => {
  const gh = new FakeGitHub();
  await prepare(gh, gh.p, env(), { inputs: { pull_request: '25', ci_run_id: '100' } });
  gh.context.files[0].after = 'new evidence';
  await assert.rejects(prepare(gh, gh.p, env(), { inputs: { pull_request: '25', ci_run_id: '100' } }), /context/);
  gh.context.subject.reviewerSha = H;
  await assert.rejects(prepare(gh, gh.p, { ...env(), GITHUB_SHA: H },
    { inputs: { pull_request: '25', ci_run_id: '100' } }), /reconciliation/);
});

test('pause during token counting stops the paid generation', async () => {
  let generations = 0;
  await assert.rejects(callReviewer(config(), context(), 'fake', async (url) => {
    if (!url.endsWith('input_tokens')) generations++;
    return Response.json({ input_tokens: 1000 });
  }, async () => { throw Error('paused'); }), /paused/);
  assert.equal(generations, 0);
});

test('App token is signed, repository-scoped and rejects another installed identity', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls = [];
  const token = await writerToken(config(), privateKey, async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/installation')) return Response.json({ id: 42, app_id: 123 });
    return Response.json({ token: 'synthetic-installation-token' });
  }, 1000000);
  assert.equal(token, 'synthetic-installation-token');
  const parts = calls[0].options.headers.Authorization.slice(7).split('.');
  assert.equal(createVerify('RSA-SHA256').update(parts.slice(0, 2).join('.')).verify(publicKey, parts[2], 'base64url'), true);
  assert.deepEqual(JSON.parse(calls[1].options.body).repositories, ['atlas']);
  await assert.rejects(writerToken(config(), privateKey, async () => Response.json({ id: 42, app_id: 999 })), /Wrong/);
});

test('configured CI names match the real workflow, including Unicode; docs receive CI', async () => {
  const yaml = await readFile(new URL('../../.github/workflows/atlas-ci.yml', import.meta.url), 'utf8');
  for (const job of defaults.requiredJobs) assert.ok(yaml.includes(`name: ${job}`), job);
  assert.equal(yaml.includes('paths:'), false);
});

test('collector reads complete before/after source via REST and rejects missing inventory or modified CI', async () => {
  const p = { ...config(), contextFiles: [] };
  let incomplete = false, changedCI = false;
  const oldText = 'export const value = 1;\n', newText = 'export const value = 2;\n';
  const blob = text => ({ sha: createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex'),
    size: Buffer.byteLength(text), path: 'src/example.ts', type: 'blob', mode: '100644' });
  const oldBlob = blob(oldText), newBlob = blob(newText);
  const gh = new GitHub(p.repository, 'fake', async (url) => {
    const path = new URL(url).pathname.split(`/repos/${p.repository}`)[1];
    let value;
    if (path === '/pulls/25') value = fixturePR();
    else if (path === '/actions/runs/100') value = fixtureRun();
    else if (path === '/actions/runs/100/attempts/1/jobs') value = { total_count: 3, jobs: fixtureJobs() };
    else if (path === `/compare/${B}...${H}`) value = { merge_base_commit: { sha: B },
      files: incomplete ? [] : [{ filename: 'src/example.ts', status: 'modified' }] };
    else if (path.startsWith('/git/trees/')) {
      const ref = path.split('/').at(-1);
      value = { truncated: false, tree: [ref === H ? newBlob : oldBlob,
        { path: CI_PATH, sha: changedCI && ref === H ? T : B }] };
    } else if (path.startsWith('/git/blobs/')) value = { encoding: 'base64',
      content: Buffer.from(path.endsWith(newBlob.sha) ? newText : oldText).toString('base64') };
    else throw Error(`Unexpected ${path}`);
    return Response.json(value);
  });
  const c = await gh.collect(25, 100, p, T);
  assert.equal(c.files[0].before, oldText); assert.equal(c.files[0].after, newText);
  assert.equal(c.subject.reviewerSha, T);
  incomplete = true; await assert.rejects(gh.collect(25, 100, p, T), /inventory/);
  incomplete = false; changedCI = true; await assert.rejects(gh.collect(25, 100, p, T), /trusted manual/);
  changedCI = false; await assert.rejects(gh.collect(25, 100, { ...p, maxContextBytes: 100 }, T), /context/);
});
