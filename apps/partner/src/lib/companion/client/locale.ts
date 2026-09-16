import * as messages from "../../paraglide/messages.js";
import type { CompanionLanguage } from "./preferences.js";

export type CompanionLocaleKey = keyof typeof messages;
export type CompanionTranslate = (key: CompanionLocaleKey, params?: Record<string, string | number>) => string;
export interface CompanionMessage { key: CompanionLocaleKey; params?: Record<string, string | number>; }

/** Thin generated-message boundary for injected and dynamic Companion text. */
export function companionTranslate(locale: CompanionLanguage): CompanionTranslate {
  return (key, params) => {
    const message = messages[key] as unknown as ((inputs?: Record<string, string | number>, options?: { locale: CompanionLanguage }) => string) | undefined;
    return message?.(params, { locale }) ?? key;
  };
}

export const english = companionTranslate("en");
