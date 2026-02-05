(() => {
  // Theme: "light" | "dark" | "system"
  const THEME_KEY = "todo_theme";

  function applyTheme(mode) {
    const root = document.documentElement;
    if (mode === "light") root.dataset.theme = "light";
    else if (mode === "dark") root.dataset.theme = "dark";
    else delete root.dataset.theme; // system
  }

  function getStoredTheme() {
    return localStorage.getItem(THEME_KEY) || "system";
  }

  function setStoredTheme(mode) {
    localStorage.setItem(THEME_KEY, mode);
  }

  // Keep in sync when OS theme changes (only matters for "system")
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener?.("change", () => {
    if (getStoredTheme() === "system") applyTheme("system");
  });

  // Apply immediately to minimize flash
  applyTheme(getStoredTheme());

  // Expose to app.js
  window.Theme = { applyTheme, getStoredTheme, setStoredTheme };
})();

