import { english, type CompanionTranslate } from "./locale.js";
export interface ComposerState {
  draft: string;
  composing: boolean;
  lastSubmitted?: string;
}

export interface ComposerCommand {
  command: string;
  label: string;
  description: string;
}

function composerCommands(t: CompanionTranslate): readonly ComposerCommand[] {
  return [
    {
      command: "/compact",
      label: t("compact.command"),
      description: t("compact.description"),
    },
  ];
}

export type ComposerEvent =
  | { type: "input"; value: string }
  | { type: "compositionstart" }
  | { type: "compositionend"; value: string }
  | { type: "submit" };

export function createComposerState(draft = ""): ComposerState {
  return { draft, composing: false };
}

/** Pure IME-aware state transition used by the Svelte composer. */
export function reduceComposer(
  state: ComposerState,
  event: ComposerEvent,
): ComposerState {
  switch (event.type) {
    case "input":
      return { ...state, draft: event.value };
    case "compositionstart":
      return { ...state, composing: true };
    case "compositionend":
      return { ...state, composing: false, draft: event.value };
    case "submit":
      if (state.composing || !state.draft.trim()) return state;
      return { draft: "", composing: false, lastSubmitted: state.draft };
  }
}

export function shouldSubmitEnter(
  event: { key: string; shiftKey?: boolean; isComposing?: boolean },
  composing: boolean,
): boolean {
  return (
    event.key === "Enter" && !event.shiftKey && !event.isComposing && !composing
  );
}

/** Return the one Companion command that can complete the slash prefix being typed. */
export function findComposerCommand(
  draft: string,
  t: CompanionTranslate = english,
): ComposerCommand | undefined {
  if (!draft.startsWith("/") || /\s/u.test(draft)) return undefined;
  return composerCommands(t).find((command) =>
    command.command.startsWith(draft),
  );
}
