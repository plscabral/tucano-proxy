import ReactDOM from "react-dom/client";
import App from "./App";

// Brand fonts bundled locally (not via CDN) so they always apply inside the
// Tauri webview, including offline. Manrope (UI/display), JetBrains Mono
// (data/code), Newsreader italic (editorial accent).
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/manrope/800.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/newsreader/400-italic.css";
import "@fontsource/newsreader/500-italic.css";
import "@fontsource/newsreader/600-italic.css";

import "./styles.css";
import "./stores/theme"; // initialize theme (light/dark/system) on boot

// No StrictMode: this app registers imperative Tauri listeners (flow stream,
// window close hook) in effects, and StrictMode's dev double-invoke would
// double-register them. Matches the original (Solid) app's single-mount model.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
