import { Show } from "solid-js";
import { t } from "../lib/i18n";

export type FindBarProps = {
  open: boolean;
  query: string;
  count: number;
  current: number;
  placeholder?: string;
  onInput: (q: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  inputRef?: (el: HTMLInputElement) => void;
};

export default function FindBar(props: FindBarProps) {
  return (
    <Show when={props.open}>
      <div class="tcn-find-row">
        <div class="tcn-find">
          <input
            ref={(el) => props.inputRef?.(el)}
            class="tcn-find-input"
            placeholder={props.placeholder ?? t("find.previewPlaceholder")}
            spellcheck={false}
            value={props.query}
            onInput={(e) => props.onInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? props.onPrev() : props.onNext(); }
              else if (e.key === "Escape") { e.preventDefault(); props.onClose(); }
            }}
          />
          <span class="tcn-find-count">{props.count === 0 ? "0" : `${props.current}/${props.count}`}</span>
          <button class="tcn-find-btn" title={t("find.prev")} onClick={props.onPrev}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
          </button>
          <button class="tcn-find-btn" title={t("find.next")} onClick={props.onNext}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <button class="tcn-find-btn" title={t("find.close")} onClick={props.onClose}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>
    </Show>
  );
}

export type FindController = {
  setQuery: (q: string) => void;
  step: (dir: 1 | -1) => void;
  close: () => void;
};
export type FindState = { count: number; current: number };
export type FindHostProps = {
  onFindMount?: (c: FindController) => void;
  onFindUnmount?: () => void;
  onFindState?: (s: FindState) => void;
};
