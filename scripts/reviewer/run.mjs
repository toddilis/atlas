import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { CHECK, LEDGER_BRANCH, REVIEW_PATH, hash, policy, reserve, reviewKey,
  eligible, requestBody, parseResponse, requireThat, sha } from './core.mjs';
import { GitHub, jsonRequest, writerToken } from './github.mjs';

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const writeJson = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + '\n');
const positive = value => { const n = Number(value); requireThat(Number.isSafeInteger(n) && n > 0, 'Invalid numeric ID'); return n; };
const output = (key, value) => appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);

export async function callReviewer(p, context, apiKey, fetcher = fetch, beforeGenerate = async () => {}) {
  requireThat(apiKey, 'Reviewer API key is not configured');
  const body = requestBody(p, context);
  const { model, instructions, input, text, truncation } = body;
  const count = await jsonRequest('https://api.openai.com/v1/responses/input_tokens', apiKey,
    { method: 'POST', body: { model, instructions, input, text, truncation }, timeoutMs: p.timeoutMs, fetcher });
  requireThat(Number.isSafeInteger(count.input_tokens) && count.input_tokens > 0 &&
    count.input_tokens <= p.maxInputTokens, 'Review input token limit exceeded');
  await beforeGenerate();
  // Exactly one generation attempt. Network/timeout uncertainty is never retried.
  const response = await jsonRequest('https://api.openai.com/v1/responses', apiKey,
    { method: 'POST', body, timeoutMs: p.timeoutMs, maxBytes: 500000, fetcher });
  parseResponse(response, context, p);
  return response;
}

async function trusted(gh, p, env) {
  const repository = await gh.call('');
  requireThat(env.GITHUB_REF === `refs/heads/${repository.default_branch}` &&
    sha(env.GITHUB_SHA) && env.GITHUB_REPOSITORY === p.repository, 'Runner must use the repository default branch');
  const run = await gh.call(`/actions/runs/${positive(env.GITHUB_RUN_ID)}`);
  requireThat(run.path === REVIEW_PATH && run.head_sha === env.GITHUB_SHA &&
    ['workflow_run', 'workflow_dispatch'].includes(run.event), 'Untrusted reviewer workflow identity');
  requireThat(hash(policy(await gh.currentPolicy(repository.default_branch))) === hash(p),
    'Review policy changed; old authority is revoked');
  return repository.default_branch;
}

async function fresh(gh, entry, p) {
  const repo = await gh.call('');
  const ref = await gh.call(`/git/ref/heads/${encodeURIComponent(repo.default_branch)}`);
  requireThat(ref.object.sha === entry.trustedSha, 'Trusted reviewer revision changed');
  requireThat(hash(policy(await gh.currentPolicy(repo.default_branch))) === hash(p), 'Review policy changed');
  const evidence = await gh.evidence(entry.subject.pr, entry.subject.ciRunId, p);
  evidence.subject.reviewerSha = entry.trustedSha;
  requireThat(hash(evidence.subject) === hash(entry.subject), 'Candidate, base or CI attempt changed');
  const trees = await Promise.all([gh.tree(entry.subject.head), gh.tree(entry.trustedSha)]);
  requireThat(trees[0].get('.github/workflows/atlas-ci.yml')?.sha ===
    trees[1].get('.github/workflows/atlas-ci.yml')?.sha, 'CI workflow changed');
  return evidence.subject;
}

async function finishCheck(gh, entry, ok, detail) {
  requireThat(Number.isSafeInteger(entry.checkId), 'Missing reserved check identity');
  await gh.call(`/check-runs/${entry.checkId}`, { method: 'PATCH', body: {
    status: 'completed', conclusion: ok ? 'success' : 'failure',
    output: { title: ok ? 'Independent review passed' : 'Independent review blocked',
      summary: `Candidate: ${entry.subject.head}\nBase: ${entry.subject.base}\n` +
        `Review: ${entry.key}\nCI: ${entry.subject.ciRunId} attempt ${entry.subject.ciAttempt}\n\n${detail}`.slice(0,60000) },
  } });
}

export async function prepare(gh, p, env, event) {
  const operation = env.REVIEW_OPERATION || 'review';
  if (operation === 'initialize') {
    requireThat(event.inputs?.operation === operation, 'Initialization requires manual dispatch');
    // Creating an existing ref fails. Never overwrite or recreate an existing ledger.
    await gh.call('/git/refs', { method: 'POST', body: {
      ref: `refs/heads/${LEDGER_BRANCH}`, sha: env.GITHUB_SHA,
    } });
    await gh.call('/contents/review-ledger.json', { method: 'PUT', body: {
      branch: LEDGER_BRANCH, message: 'Initialize bounded reviewer ledger',
      content: Buffer.from(JSON.stringify({ version: 1, paused: false, entries: [] })).toString('base64'),
    } });
    return { dispatch: false };
  }
  if (operation === 'pause' || operation === 'resume') {
    requireThat(event.inputs?.operation === operation, 'Control requires explicit manual dispatch');
    const snapshot = await gh.ledger();
    snapshot.value.paused = operation === 'pause';
    await gh.saveLedger(snapshot);
    return { dispatch: false };
  }
  requireThat(operation === 'review', 'Unknown operation');
  const runId = positive(event.workflow_run?.id ?? event.inputs?.ci_run_id);
  const prNumber = positive(event.inputs?.pull_request ?? event.workflow_run?.pull_requests?.[0]?.number);
  const pr = await gh.call(`/pulls/${prNumber}`);
  requireThat(pr.head.repo?.full_name === p.repository && sha(pr.head.sha), 'Unsupported PR source');
  const check = await gh.call('/check-runs', { method: 'POST', body: {
    name: CHECK, head_sha: pr.head.sha, status: 'in_progress',
    details_url: `https://github.com/${p.repository}/actions/runs/${positive(env.GITHUB_RUN_ID)}`,
    output: { title: 'Preparing independent review', summary: 'Collecting exact-candidate evidence and reserving budget.' },
  } });
  let entry = { checkId: check.id, subject: { head: pr.head.sha, base: pr.base.sha }, key: 'unreserved' };
  try {
    requireThat(p.enabled, 'Reviewer is disabled; configure the approved model, budget and environment first');
    const context = await gh.collect(prNumber, runId, p, env.GITHUB_SHA);
    const snapshot = await gh.ledger();
    const reservation = reserve(snapshot.value, p, context.subject, positive(env.GITHUB_RUN_ID),
      hash(context), env.GITHUB_SHA);
    entry = { ...reservation.entry, checkId: check.id };
    if (!reservation.created) {
      requireThat(entry.contextHash === hash(context) && entry.trustedSha === env.GITHUB_SHA,
        'Review context or trusted runner changed');
      const subject = await fresh(gh, entry, p);
      const ok = eligible(entry, p, subject, snapshot.value.paused);
      const detail = ok ? 'Reused durable review receipt; no new model request.' :
        'Existing reservation is blocked or unresolved. Reconcile the original run; no paid retry.';
      // Repair the original durable check too: gate() verifies that exact ID.
      await finishCheck(gh, reservation.entry, ok, detail);
      await finishCheck(gh, entry, ok, detail);
      return { dispatch: false };
    }
    requireThat(env.GITHUB_RUN_ATTEMPT === '1', 'A rerun cannot launch another model request');
    Object.assign(reservation.entry, { checkId: check.id });
    await gh.saveLedger(snapshot);
    return { dispatch: true, key: entry.key, context, entry };
  } catch (error) {
    await finishCheck(gh, entry, false, error.message);
    throw error;
  }
}

export async function publish(gh, p, env, bundle, response) {
  const snapshot = await gh.ledger();
  const entry = snapshot.value.entries.find(e => e.key === bundle.key);
  requireThat(entry && entry.workflowRunId === positive(env.GITHUB_RUN_ID) &&
    entry.trustedSha === env.GITHUB_SHA && entry.policyHash === hash(p) &&
    entry.contextHash === hash(bundle.context) && hash(entry.subject) === hash(bundle.context.subject),
  'Review artifact does not match its durable reservation');
  if (entry.status !== 'completed') {
    try {
      await fresh(gh, entry, p);
      requireThat(p.enabled && !snapshot.value.paused, 'Reviewer disabled or paused');
      entry.review = parseResponse(response, bundle.context, p);
      entry.status = 'completed';
    } catch (error) {
      entry.status = 'blocked'; entry.reason = error.message;
    }
    // Commit receipt BEFORE publishing success. A killed publisher can repeat safely.
    await gh.saveLedger(snapshot);
  }
  let ok = false;
  try { ok = eligible(entry, p, await fresh(gh, entry, p), snapshot.value.paused); }
  catch { /* stale receipt stays evidence but cannot supply present authority */ }
  const detail = entry.review ? JSON.stringify(entry.review.result, null, 2) : entry.reason;
  await finishCheck(gh, entry, ok, detail || 'No complete response; reconciliation required.');
  return ok;
}

export async function gate(gh, p, prNumber) {
  const repo = await gh.call('');
  requireThat(hash(policy(await gh.currentPolicy(repo.default_branch))) === hash(p), 'Gate policy is stale');
  const snapshot = await gh.ledger();
  const pr = await gh.call(`/pulls/${prNumber}`);
  const ref = await gh.call(`/git/ref/heads/${encodeURIComponent(repo.default_branch)}`);
  const key = reviewKey({ repository: p.repository, pr: prNumber, head: pr.head.sha, base: pr.base.sha,
    reviewerSha: ref.object.sha }, hash(p));
  const entry = snapshot.value.entries.find(e => e.key === key);
  requireThat(entry && eligible(entry, p, await fresh(gh, entry, p), snapshot.value.paused),
    'Current candidate has no eligible independent review');
  const check = await gh.call(`/check-runs/${entry.checkId}`);
  requireThat(check.app?.id === p.writerAppId && check.name === CHECK && check.head_sha === pr.head.sha &&
    check.status === 'completed' && check.conclusion === 'success', 'Review publisher provenance is invalid');
  return { eligible: true, candidate: pr.head.sha, base: pr.base.sha, reviewKey: key,
    workflowRunId: entry.workflowRunId, responseId: entry.review.responseId, ciRunId: entry.subject.ciRunId };
}

async function main(env = process.env) {
  const p = policy(await readJson(new URL('./policy.json', import.meta.url)));
  let gh = new GitHub(p.repository, env.GH_TOKEN);
  const command = process.argv[2];
  if (command === 'gate') {
    console.log(JSON.stringify(await gate(gh, p, positive(process.argv[3])))); return;
  }
  await trusted(gh, p, env);
  if (command === 'prepare' || command === 'publish') {
    gh = new GitHub(p.repository, await writerToken(p, env.ATLAS_REVIEW_APP_PRIVATE_KEY));
  }
  if (command === 'prepare') {
    const bundle = await prepare(gh, p, env, await readJson(env.GITHUB_EVENT_PATH));
    await mkdir('review-artifacts', { recursive: true });
    await writeJson('review-artifacts/request.json', bundle);
    await output('dispatch', bundle.dispatch ? 'true' : 'false');
  } else if (command === 'review') {
    const bundle = await readJson('review-artifacts/request.json');
    const snapshot = await gh.ledger();
    const entry = snapshot.value.entries.find(e => e.key === bundle.key);
    requireThat(env.GITHUB_RUN_ATTEMPT === '1' && entry?.status === 'reserved' &&
      entry.workflowRunId === positive(env.GITHUB_RUN_ID) && entry.trustedSha === env.GITHUB_SHA &&
      entry.policyHash === hash(p) && entry.contextHash === hash(bundle.context) &&
      p.enabled && !snapshot.value.paused, 'No current unused review reservation');
    await fresh(gh, entry, p);
    const response = await callReviewer(p, bundle.context, env.OPENAI_API_KEY, fetch, async () => {
      const current = await gh.ledger();
      requireThat(!current.value.paused, 'Reviewer paused before paid dispatch');
      await fresh(gh, entry, p);
    });
    await writeJson('review-artifacts/response.json', response);
  } else if (command === 'publish') {
    const bundle = await readJson('review-artifacts/request.json');
    let response;
    try { response = await readJson('review-artifacts/response.json'); } catch { /* missing = blocked */ }
    const ok = await publish(gh, p, env, bundle, response);
    await appendFile(env.GITHUB_STEP_SUMMARY, `Independent review ${ok ? 'passed' : 'blocked'} for ${bundle.entry.subject.head}.\n`);
    if (!ok) process.exitCode = 1;
  } else throw new Error('Expected prepare, review, publish or gate');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Reviewer stopped; inspect the check and durable ledger. No automatic paid retry.'); process.exitCode = 1; });
}
