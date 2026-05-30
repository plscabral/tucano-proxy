import { useFlows } from "@/stores/flows";
import { useRules } from "@/stores/rules";
import { useUndo } from "@/stores/undo";
import { ipc } from "./ipc";
import { applyRules } from "./rules";

/**
 * Retroactively drop every already-captured flow that doesn't match the active
 * filter rules — used when the user turns the capture filter ON, so the list
 * is purged immediately (not only for traffic arriving afterwards).
 * Removed flows are pushed to the undo stack so the action is recoverable.
 */
export function purgeNonMatchingNow() {
  const rs = useRules.getState();
  const active = rs.list.filter((r) => r.enabled && r.value.trim() !== "");
  if (active.length === 0) return;

  const all = useFlows.getState().flows;
  const keep = new Set(applyRules(all, active, rs.matchMode).map((f) => f.id));
  const drop = all.filter((f) => !keep.has(f.id));
  if (drop.length === 0) return;

  useUndo.getState().push(drop.slice());
  useFlows.getState().removeMany(new Set(drop.map((f) => f.id)));
  ipc.deleteFlows(drop.map((f) => f.id)).catch(() => {});
}
