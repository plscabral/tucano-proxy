import { createSignal } from "solid-js";

const [openId, setOpenId] = createSignal<string | null>(null);

export const noteStore = {
  openId,
  open(id: string) { setOpenId(id); },
  close() { setOpenId(null); },
};
