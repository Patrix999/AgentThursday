/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // M7.1: lg=1024px is the desktop / mobile boundary (per an earlier revision §A-1).
    },
  },
  plugins: [],
};
