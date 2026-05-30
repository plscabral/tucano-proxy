import { create } from "zustand";

type NoteState = {
  openId: string | null;
  open: (id: string) => void;
  close: () => void;
};

export const useNote = create<NoteState>((set) => ({
  openId: null,
  open(id) { set({ openId: id }); },
  close() { set({ openId: null }); },
}));
