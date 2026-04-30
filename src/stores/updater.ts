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
