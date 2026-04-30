import { createSignal } from "solid-js";

const KEY = "tucano:sessionPath";

const [path, setPath] = createSignal<string | null>(localStorage.getItem(KEY));

export const sessionStore = {
  /** Currently bound on-disk path for the active capture session. */
  path,
  setPath(p: string | null) {
    setPath(p);
    if (p) localStorage.setItem(KEY, p);
    else localStorage.removeItem(KEY);
  },
};
