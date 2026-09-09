import { preferenceStorage } from "@/lib/platform";
import { create } from "zustand";

const KEY = "tucano:sessionPath";

type SessionState = {
  /** Currently bound on-disk path for the active capture session. */
  path: string | null;
  setPath: (p: string | null) => void;
};

export const useSession = create<SessionState>((set) => ({
  path: preferenceStorage.getItem(KEY),
  setPath(p) {
    set({ path: p });
    if (p) preferenceStorage.setItem(KEY, p);
    else preferenceStorage.removeItem(KEY);
  },
}));
