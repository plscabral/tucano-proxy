import { create } from "zustand";

// Shared preview/source tab across all HTML/XML viewers (request + response),
// mirroring the original module-level signal so toggling one toggles both.
type PreviewTab = "preview" | "source";
export const usePreviewTab = create<{ tab: PreviewTab; setTab: (t: PreviewTab) => void }>((set) => ({
  tab: "source",
  setTab: (tab) => set({ tab }),
}));
