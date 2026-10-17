import path from 'node:path';

const repoRoot = path.resolve(process.cwd(), '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The console runs alongside the API server (port 3001). Keep them separate processes
  // so the API stays a thin Fastify server and the console can deploy independently in a
  // later PR.
  //
  // The console uses the platform's own pricing calculator (src/platform/pricing), so the
  // bundle root is the repository. Its zod import resolves to the console's dependency,
  // since the console is built with only web/ installed.
  turbopack: {
    root: repoRoot,
    // Resolved relative to this directory (the Next project), wherever the importer lives.
    resolveAlias: { zod: './node_modules/zod' },
  },
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
