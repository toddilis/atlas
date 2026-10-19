import { createHash, createSign } from 'node:crypto';
import { CI_PATH, LEDGER_BRANCH, POLICY_PATH, requireThat, sha, validateCI } from './core.mjs';

export async function jsonRequest(url, token, { method = 'GET', body, timeoutMs = 30000,
  maxBytes = 2000000, fetcher = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { method, redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
        'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) {
      // Do not log provider bodies: they may echo source, instructions or credentials.
      const error = new Error(`Remote request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      requireThat(size <= maxBytes, 'Remote response exceeded size limit');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { clearTimeout(timer); }
}

export class GitHub {
  constructor(repository, token, fetcher = fetch) {
    requireThat(/^[\w.-]+\/[\w.-]+$/.test(repository) && token, 'GitHub repository/token missing');
    this.repository = repository; this.token = token; this.fetcher = fetcher;
  }
  call(path, options = {}) {
    requireThat((path === '' || path.startsWith('/')) && !/[\r\n#]/.test(path), 'Invalid API path');
    return jsonRequest(`https://api.github.com/repos/${this.repository}${path}`, this.token,
      { ...options, fetcher: this.fetcher });
  }
  async tree(ref) {
    requireThat(sha(ref), 'Invalid source SHA');
    const result = await this.call(`/git/trees/${ref}?recursive=1`);
    requireThat(!result.truncated && Array.isArray(result.tree), 'Source tree is incomplete');
    return new Map(result.tree.map(x => [x.path, x]));
  }
  async file(tree, path, maxBytes) {
    const item = tree.get(path);
    requireThat(item && item.type === 'blob' && ['100644', '100755'].includes(item.mode) &&
      item.size <= maxBytes, 'Missing, oversized or unsupported source file');
    const blob = await this.call(`/git/blobs/${item.sha}`, { maxBytes: maxBytes * 2 + 2000 });
    requireThat(blob.encoding === 'base64', 'Unsupported blob encoding');
    const bytes = Buffer.from(blob.content, 'base64');
    const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    requireThat(actual === item.sha && bytes.length === item.size && !bytes.includes(0), 'Corrupt or binary source');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    requireThat(!content.startsWith('version https://git-lfs.github.com/spec/'), 'LFS source is not available');
    return content;
  }
  async evidence(prNumber, runId, p) {
    const [pr, run] = await Promise.all([
      this.call(`/pulls/${prNumber}`), this.call(`/actions/runs/${runId}`),
    ]);
    const result = await this.call(`/actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100`);
    requireThat(result.total_count === result.jobs.length, 'CI job list is incomplete');
    return { pr, run, jobs: result.jobs, subject: validateCI(run, result.jobs, pr, p) };
  }
  async collect(prNumber, runId, p, trustedSha) {
    const evidence = await this.evidence(prNumber, runId, p);
    const { pr, subject, jobs } = evidence;
    subject.reviewerSha = trustedSha;
    const comparison = await this.call(`/compare/${subject.base}...${subject.head}?per_page=1`);
    requireThat(sha(comparison.merge_base_commit?.sha) && Array.isArray(comparison.files) &&
      comparison.files.length === pr.changed_files && pr.changed_files > 0 &&
      pr.changed_files <= p.maxFiles, 'Change inventory incomplete or too large');
    const [before, after, trusted] = await Promise.all([
      this.tree(comparison.merge_base_commit.sha), this.tree(subject.head), this.tree(trustedSha),
    ]);
    // CI's success is not trusted if the candidate changed the verifier workflow.
    requireThat(after.get(CI_PATH)?.sha === trusted.get(CI_PATH)?.sha, 'CI workflow requires trusted manual review');
    const context = { subject, mergeBase: comparison.merge_base_commit.sha,
      title: pr.title, description: pr.body ?? '',
      ci: jobs.map(j => ({ name: j.name, conclusion: j.conclusion, url: j.html_url })),
      guidance: [], files: [] };
    const bound = () => requireThat(Buffer.byteLength(JSON.stringify(context)) <= p.maxContextBytes,
      'Complete review context exceeds limit; split the PR or use manual review');
    for (const path of p.contextFiles) {
      context.guidance.push({ path, revision: trustedSha, content: await this.file(trusted, path, p.maxContextBytes) });
      bound();
    }
    for (const change of comparison.files) {
      requireThat(['added', 'removed', 'modified', 'renamed'].includes(change.status), 'Unsupported change kind');
      const oldPath = change.previous_filename ?? change.filename;
      context.files.push({ path: change.filename, oldPath, status: change.status,
        before: change.status === 'added' ? null : await this.file(before, oldPath, p.maxContextBytes),
        after: change.status === 'removed' ? null : await this.file(after, change.filename, p.maxContextBytes) });
      bound();
    }
    return context;
  }
  async ledger() {
    // Deliberately no auto-initialization: a missing/deleted ledger never resets a budget.
    const file = await this.call(`/contents/review-ledger.json?ref=${LEDGER_BRANCH}`);
    requireThat(file.encoding === 'base64' && sha(file.sha), 'Invalid ledger file');
    const value = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    requireThat(value.version === 1 && typeof value.paused === 'boolean' &&
      Array.isArray(value.entries) && value.entries.length <= 100, 'Invalid ledger');
    return { sha: file.sha, value };
  }
  async saveLedger(snapshot) {
    requireThat(Buffer.byteLength(JSON.stringify(snapshot.value)) < 800000, 'Ledger capacity reached; operator archival required');
    await this.call('/contents/review-ledger.json', { method: 'PUT', body: {
      branch: LEDGER_BRANCH, sha: snapshot.sha, message: 'Record independent review evidence',
      content: Buffer.from(JSON.stringify(snapshot.value)).toString('base64'),
    } }); // GitHub's blob SHA precondition is CAS. Never retry an uncertain mutation.
  }
  async currentPolicy(defaultBranch) {
    const data = await this.call(`/contents/${POLICY_PATH}?ref=${encodeURIComponent(defaultBranch)}`);
    requireThat(data.encoding === 'base64', 'Policy unavailable');
    return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  }
}

// Dedicated App identity; never grant ledger/check write permissions to candidate
// GITHUB_TOKEN workflows. Its private key lives only in a main-only environment.
export async function writerToken(p, privateKey, fetcher = fetch, now = Date.now()) {
  requireThat(p.writerAppId > 0 && privateKey, 'Protected reviewer App credential is not configured');
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540, iss: String(p.writerAppId),
  })}`;
  const jwt = `${data}.${createSign('RSA-SHA256').update(data).sign(privateKey, 'base64url')}`;
  const installation = await jsonRequest(`https://api.github.com/repos/${p.repository}/installation`, jwt, { fetcher });
  requireThat(installation.app_id === p.writerAppId && Number.isSafeInteger(installation.id), 'Wrong reviewer App installation');
  const token = await jsonRequest(`https://api.github.com/app/installations/${installation.id}/access_tokens`, jwt, {
    method: 'POST', fetcher, body: { repositories: [p.repository.split('/')[1]], permissions: {
      contents: 'write', checks: 'write', actions: 'read', pull_requests: 'read',
    } },
  });
  requireThat(typeof token.token === 'string' && token.token.length > 0, 'Missing reviewer installation token');
  return token.token;
}
