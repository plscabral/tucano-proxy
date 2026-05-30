import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./stores/theme"; // initialize theme (light/dark/system) on boot

// No StrictMode: this app registers imperative Tauri listeners (flow stream,
// window close hook) in effects, and StrictMode's dev double-invoke would
// double-register them. Matches the original (Solid) app's single-mount model.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
