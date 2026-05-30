import { create } from "zustand";

const KEY = "tucano:sessionPath";

type SessionState = {
  /** Currently bound on-disk path for the active capture session. */
  path: string | null;
  setPath: (p: string | null) => void;
};

export const useSession = create<SessionState>((set) => ({
  path: localStorage.getItem(KEY),
  setPath(p) {
    set({ path: p });
    if (p) localStorage.setItem(KEY, p);
    else localStorage.removeItem(KEY);
  },
}));
