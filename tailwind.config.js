module.exports = {
  content: ["./public/index.html", "./public/js/**/*.js"],
  safelist: [
    'badge', 'b-neutral', 'b-brand', 'b-success', 'b-warning', 'b-danger', 'b-info',
    'btn-warn'
  ],
  theme: {
    extend: {
      colors: {
        canvas: "var(--canvas)",
        surface: { 1: "var(--surface-1)", 2: "var(--surface-2)", 3: "var(--surface-3)" },
        brand: { DEFAULT: "#5865F2", hover: "#6874F7", dark: "#4752C4", light: "#727EF6", soft: "var(--brand-soft)" },
        success: "var(--success)", warning: "var(--warning)", danger: "var(--danger)", info: "var(--info)",
        ink: { DEFAULT: "var(--text-primary)", 2: "var(--text-secondary)", 3: "var(--text-muted)" },
      },
      borderColor: { subtle: "var(--border-subtle)", DEFAULT: "var(--border-default)", strong: "var(--border-strong)" },
      fontFamily: { sans: ["Plus Jakarta Sans", "system-ui", "sans-serif"], mono: ["Plus Jakarta Sans", "system-ui", "sans-serif"] },
      borderRadius: { DEFAULT: "10px", lg: "14px" },
    },
  },
  plugins: [],
};
