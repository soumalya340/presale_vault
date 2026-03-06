import type { NextConfig } from "next";
import webpack from "webpack";

const nextConfig: NextConfig = {
  // Turbopack (Next.js 16 default) — declare so Next.js doesn't error when
  // it sees a webpack config alongside Turbopack mode.
  turbopack: {},

  // Webpack config is used when building with --webpack or in older Next.js.
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
    };
    config.plugins.push(
      new webpack.ProvidePlugin({
        Buffer: ["buffer", "Buffer"],
      })
    );
    return config;
  },
};

export default nextConfig;
