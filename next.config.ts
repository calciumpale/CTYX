import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vinext inspects multipart bodies before dispatching API routes. Leave room
  // for the 20 MiB recording and form headers; the upload route enforces its own limit.
  experimental: { serverActions: { bodySizeLimit: '21mb' } },
};

export default nextConfig;
