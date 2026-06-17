import withPWAInit from "next-pwa";

const withPWA = withPWAInit({
  dest: "public",
  register: true,
  skipWaiting: true,
  // Disable the service worker in dev to avoid caching headaches; enabled for
  // production builds so the app is installable on Windows via Edge/Chrome.
  disable: process.env.NODE_ENV === "development",
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Server-only SDKs that should not be bundled into the client.
  experimental: {
    serverComponentsExternalPackages: [
      "@aws-sdk/client-textract",
      "@anthropic-ai/sdk",
    ],
  },
  webpack: (config) => {
    // react-pdf / pdfjs-dist tries to resolve the optional `canvas` package
    // which is a native Node dependency we never use in the browser.
    config.resolve.alias = {
      ...config.resolve.alias,
      canvas: false,
    };
    return config;
  },
};

export default withPWA(nextConfig);
