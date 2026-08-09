import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

const THEME_STORAGE_KEY = "submonitor-theme";
const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
const theme = ["light", "dark", "system"].includes(savedTheme) ? savedTheme : "system";
const resolvedTheme = theme === "system"
  ? (window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light")
  : theme;
document.documentElement.dataset.theme = resolvedTheme;
document.documentElement.style.colorScheme = resolvedTheme;
document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolvedTheme === "dark" ? "#0f141a" : "#f4f6f8");

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
