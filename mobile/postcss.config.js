// Self-contained: an empty PostCSS config so Vite does NOT walk up to the
// repo-root postcss.config.mjs (which loads Tailwind). This mobile app uses
// plain CSS only and shares no build config with desktop/worker.
export default { plugins: {} };
