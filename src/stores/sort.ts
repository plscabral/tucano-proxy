import { createSignal } from "solid-js";
import type { ColId } from "./columns";

const KEY = "tucano:sort";

type State = { by: ColId | null; dir: "asc" | "desc" };

function load(): State {
  try { return JSON.parse(localStorage.getItem(KEY) || "") as State; }
  catch { return { by: null, dir: "asc" }; }
}

const [state, setState] = createSignal<State>(load());

function persist() { localStorage.setItem(KEY, JSON.stringify(state())); }

export const sortStore = {
  state,
  toggle(col: ColId) {
    const s = state();
    if (s.by !== col) setState({ by: col, dir: "asc" });
    else if (s.dir === "asc") setState({ by: col, dir: "desc" });
    else setState({ by: null, dir: "asc" });
    persist();
  },
  clear() { setState({ by: null, dir: "asc" }); persist(); },
};
