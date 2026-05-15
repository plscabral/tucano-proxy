/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Deeper, warmer ink palette — slight blue-purple tilt at the
        // darkest end so the dark mode reads as cinematic instead of flat
        // navy. Lighter shades stay neutral so text remains crisp.
        ink: {
          DEFAULT: "#080D1B",
          50:  "#EDEEF3",
          100: "#C7C9D6",
          200: "#7A8099",
          300: "#373C56",
          400: "#141A2E",
          500: "#080D1B",
          600: "#080D1B",
          700: "#080D1B",
          800: "#03050A",
          900: "#010205",
        },
        // Slightly richer toucan — same brand identity, more saturated mid
        // tones so it pops against the deeper ink without losing warmth.
        toucan: {
          DEFAULT: "#FB8E37",
          50:  "#FEF1E5",
          100: "#FDDFC0",
          200: "#FCC287",
          300: "#FBA659",
          400: "#FB8E37",
          500: "#F47410",
          600: "#D55D06",
          700: "#A04606",
          800: "#6C2F04",
          900: "#391902",
        },
        // Companion accent (cool counterweight to toucan). Used sparingly
        // for active selection states / subtle gradients.
        cobalt: {
          400: "#7AA2FF",
          500: "#5B86FF",
          600: "#3D6BE6",
        },
      },
      fontFamily: {
        sans: ["Geist", "Manrope", "system-ui", "sans-serif"],
        mono: ["Geist Mono", "JetBrains Mono", "ui-monospace", "monospace"],
      },
      boxShadow: {
        glow: "0 0 24px -6px rgb(251 142 55 / 0.55)",
        soft: "0 1px 0 rgb(255 255 255 / 0.04) inset, 0 1px 3px rgb(0 0 0 / 0.20)",
        elev: "0 12px 40px -12px rgb(0 0 0 / 0.55), 0 1px 0 rgb(255 255 255 / 0.04) inset",
      },
      backdropBlur: {
        xs: "2px",
      },
    },
  },
  plugins: [],
};
