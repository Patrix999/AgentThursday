/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // lg=1024px is the desktop / mobile boundary (per §A-1).
    },
  },
  plugins: [],
};
