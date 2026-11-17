/** @type {import('tailwindcss').Config} */
const tone = (name) => ({
  [`${name}-fg`]: `var(--${name}-fg)`,
  [`${name}-bg`]: `var(--${name}-bg)`,
  [`${name}-border`]: `var(--${name}-border)`,
});

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        panel: "var(--panel)",
        border: "var(--border)",
        muted: "var(--muted)",
        fg: "var(--fg)",
        accent: "var(--accent)",
        ...tone("warn"),
        ...tone("danger"),
        ...tone("ok"),
        ...tone("info"),
        ...tone("violet"),
      },
    },
  },
  plugins: [],
};
