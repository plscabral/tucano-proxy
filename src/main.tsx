/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import "./styles.css";
import "./stores/theme"; // initializes theme (light/dark/system)

render(() => <App />, document.getElementById("root")!);
