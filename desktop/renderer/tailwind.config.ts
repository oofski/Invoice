import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Neroli Salon & Spa reskin — flat token set (see index.css :root vars)
        bg: "#F6F4F1",
        surface: "#FFFFFF",
        "surface-2": "#F1EEEA",
        elevated: "#FFFFFF",
        ink: "#2E2F30",
        "ink-muted": "#5B5650",
        "ink-subtle": "#857F78",
        line: "#E3DED7",
        "line-strong": "#CFD2D2",
        primary: "#424445",
        "primary-hover": "#333536",
        "primary-fg": "#FFFFFF",
        accent: "#9A6F62",
        "accent-hover": "#845C50",
        "accent-fg": "#FFFFFF",
        "accent-soft": "#AC9089",
        "selected-bg": "#F3EBE6",
        "selected-border": "#D8C3B5",
        success: "#3F6F57",
        "success-hover": "#345C48",
        "success-fg": "#FFFFFF",
        "success-soft-bg": "#E7EFEA",
        "success-soft-fg": "#2E5A45",
        danger: "#A23B32",
        "danger-hover": "#8A3029",
        "danger-fg": "#FFFFFF",
        "danger-soft-bg": "#F6E7E4",
        "danger-soft-fg": "#8A2E26",
        review: "#C0392B",
        warning: "#9A6B1E",
        "warning-soft-bg": "#F4EAD8",
        "warning-soft-fg": "#7A521A",
        info: "#5B6E6E",
        "info-soft-bg": "#E6ECEC",
        "info-soft-fg": "#3C4C4C",
        ring: "#9A6F62",
        sidebar: "#2E2F30",
        "sidebar-2": "#3A3B3C",
        // Legacy alias → primary (kept in case anything still reads `brand`).
        brand: {
          DEFAULT: "#424445",
          accent: "#9A6F62",
        },
      },
      fontFamily: {
        sans: [
          '"Hanken Grotesk"',
          "system-ui",
          "-apple-system",
          '"Segoe UI"',
          "sans-serif",
        ],
        display: [
          '"Cormorant Garamond"',
          '"Hanken Grotesk"',
          "Georgia",
          "serif",
        ],
        wordmark: [
          '"Marcellus"',
          '"Cormorant Garamond"',
          "Georgia",
          "serif",
        ],
      },
      boxShadow: {
        card: "0 1px 2px rgba(46,47,48,0.04), 0 4px 16px -8px rgba(46,47,48,0.10)",
      },
      keyframes: {
        // Manual-review pulse (Brief §08: MANUAL_REVIEW red pulse)
        "review-pulse": {
          "0%, 100%": { boxShadow: "0 0 0 0 rgba(192, 57, 43, 0.5)" },
          "50%": { boxShadow: "0 0 0 5px rgba(192, 57, 43, 0)" },
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
