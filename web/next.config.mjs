/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The console runs alongside the API server (port 3001). Keep them separate processes
  // so the API stays a thin Fastify server and the console can deploy independently in a
  // later PR.
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
