import { createSignal } from "solid-js";
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

const [state, setState] = createSignal<UpdaterState>("idle");
const [version, setVersion] = createSignal<string | null>(null);
const [notes, setNotes] = createSignal<string | null>(null);
const [progress, setProgress] = createSignal(0);
const [error, setError] = createSignal<string | null>(null);

let pendingUpdate: Update | null = null;

async function checkForUpdate(): Promise<void> {
  if (state() === "checking" || state() === "downloading") return;
  setState("checking");
  setError(null);
  try {
    const update = await check();
    if (update) {
      pendingUpdate = update;
      setVersion(update.version);
      setNotes(update.body ?? null);
      setState("available");
    } else {
      pendingUpdate = null;
      setState("upToDate");
    }
  } catch (e) {
    setError(String(e));
    setState("error");
  }
}

async function downloadAndInstall(): Promise<void> {
  if (!pendingUpdate) return;
  setState("downloading");
  setProgress(0);
  let total = 0;
  let downloaded = 0;
  try {
    await pendingUpdate.download((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        setProgress(total > 0 ? downloaded / total : 0);
      }
    });
    setState("ready");
  } catch (e) {
    setError(String(e));
    setState("error");
  }
}

async function installAndRestart(): Promise<void> {
  try {
    if (pendingUpdate) {
      // install() applies the update; relaunch restarts the app cleanly.
      await pendingUpdate.install();
    }
    await relaunch();
  } catch (e) {
    setError(String(e));
    setState("error");
  }
}

async function installSilently(): Promise<void> {
  if (state() !== "ready" || !pendingUpdate) return;
  // Re-check before applying. The staged `pendingUpdate` was frozen at download
  // time — if a newer release has been published since, install-on-quit would
  // otherwise apply the stale version and force the user through a second
  // upgrade cycle on the next launch (e.g. v0.1.10 → v0.1.11 → v0.1.12).
  // Bounded with a short timeout so we don't hang the quit path on a flaky
  // network.
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
      setVersion(latest.version);
      setNotes(latest.body ?? null);
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
}

export const updaterStore = {
  state,
  version,
  notes,
  progress,
  error,
  check: checkForUpdate,
  download: downloadAndInstall,
  restart: installAndRestart,
  installOnQuit: installSilently,
  hasReadyUpdate: () => state() === "ready",
};
