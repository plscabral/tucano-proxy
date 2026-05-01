/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: "#0F182E",
          50: "#E6E8F0",
          100: "#BFC6D9",
          200: "#828DAE",
          300: "#414C72",
          400: "#1F2848",
          500: "#0F182E",
          600: "#0B1426",
          700: "#080F1D",
          800: "#050A14",
          900: "#02050A",
        },
        toucan: {
          DEFAULT: "#F99245",
          50: "#FEF1E5",
          100: "#FDE0C2",
          200: "#FCC489",
          300: "#FAA85F",
          400: "#F99245",
          500: "#F77A1E",
          600: "#D7610A",
          700: "#A24808",
          800: "#6E3105",
          900: "#3A1A03",
        },
      },
      fontFamily: {
        sans: ["Manrope", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
