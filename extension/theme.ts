// Run before styles load so the saved preference applies on the first paint.
(() => {
  type Theme = "dark" | "light";
  const key = "brauser_theme";
  const root = document.documentElement;

  function readTheme(): Theme {
    try {
      return localStorage.getItem(key) === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  }

  function applyTheme(theme: Theme): void {
    root.dataset.theme = theme;
    const toggle = document.querySelector<HTMLButtonElement>("[data-theme-toggle]");
    if (toggle) {
      toggle.setAttribute("aria-pressed", String(theme === "dark"));
      toggle.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
    }
  }

  applyTheme(readTheme());
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) applyTheme(readTheme());
  });
  document.addEventListener("DOMContentLoaded", () => {
    applyTheme(root.dataset.theme === "light" ? "light" : "dark");
    document.querySelector<HTMLButtonElement>("[data-theme-toggle]")?.addEventListener("click", () => {
      const theme = root.dataset.theme === "light" ? "dark" : "light";
      applyTheme(theme);
      try {
        localStorage.setItem(key, theme);
      } catch {
        // Keep the new theme in this view when storage is unavailable.
      }
    });
  }, { once: true });
})();
