/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: "#0C142E",
          50: "#E6E8EE",
          100: "#C5CAD7",
          200: "#8C95B0",
          300: "#525F88",
          400: "#2A335A",
          500: "#0C142E",
          600: "#0A1128",
          700: "#070D20",
          800: "#050918",
          900: "#02040C",
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
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
