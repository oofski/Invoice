import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#0f172a",
          accent: "#2563eb",
        },
      },
      keyframes: {
        // Manual-review pulse (Brief §08: MANUAL_REVIEW red pulse)
        "review-pulse": {
          "0%, 100%": { boxShadow: "0 0 0 0 rgba(220, 38, 38, 0.5)" },
          "50%": { boxShadow: "0 0 0 5px rgba(220, 38, 38, 0)" },
        },
      },
      animation: {
        "review-pulse": "review-pulse 1.8s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
export default config;
