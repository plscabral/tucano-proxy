import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdaterState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "upToDate"
  | "error";

let pendingUpdate: Update | null = null;

type UpdaterStore = {
  state: UpdaterState;
  version: string | null;
  notes: string | null;
  progress: number;
  error: string | null;
  check: () => Promise<void>;
  download: () => Promise<void>;
  restart: () => Promise<void>;
  installOnQuit: () => Promise<void>;
  hasReadyUpdate: () => boolean;
};

export const useUpdater = create<UpdaterStore>((set, get) => ({
  state: "idle",
  version: null,
  notes: null,
  progress: 0,
  error: null,

  async check() {
    if (get().state === "checking" || get().state === "downloading") return;
    set({ state: "checking", error: null });
    try {
      const update = await check();
      if (update) {
        pendingUpdate = update;
        set({ version: update.version, notes: update.body ?? null, state: "available" });
      } else {
        pendingUpdate = null;
        set({ state: "upToDate" });
      }
    } catch (e) {
      set({ error: String(e), state: "error" });
    }
  },

  async download() {
    if (!pendingUpdate) return;
    set({ state: "downloading", progress: 0 });
    let total = 0;
    let downloaded = 0;
    try {
      await pendingUpdate.download((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          set({ progress: total > 0 ? downloaded / total : 0 });
        }
      });
      set({ state: "ready" });
    } catch (e) {
      set({ error: String(e), state: "error" });
    }
  },

  async restart() {
    try {
      if (pendingUpdate) {
        // install() applies the update; relaunch restarts the app cleanly.
        await pendingUpdate.install();
      }
      await relaunch();
    } catch (e) {
      set({ error: String(e), state: "error" });
    }
  },

  async installOnQuit() {
    if (get().state !== "ready" || !pendingUpdate) return;
    // Re-check before applying. The staged `pendingUpdate` was frozen at
    // download time — if a newer release has been published since, install-on-
    // quit would otherwise apply the stale version and force the user through a
    // second upgrade cycle on the next launch. Bounded with a short timeout so
    // we don't hang the quit path on a flaky network.
    try {
      const latest = await Promise.race<Update | null>([
        check(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
      ]);
      if (latest && latest.version !== pendingUpdate.version) {
        console.info(
          `[updater] newer version ${latest.version} found at quit, replacing staged ${pendingUpdate.version}`,
        );
        pendingUpdate = latest;
        set({ version: latest.version, notes: latest.body ?? null });
        await latest.download();
      }
    } catch (e) {
      console.warn("[updater] re-check on quit failed, installing staged version", e);
    }
    try {
      await pendingUpdate.install();
    } catch (e) {
      // Best-effort on close; swallow errors so the app can still exit.
      console.error("[updater] silent install failed", e);
    }
  },

  hasReadyUpdate: () => get().state === "ready",
}));
