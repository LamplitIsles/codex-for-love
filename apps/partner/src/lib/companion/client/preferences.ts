export type CompanionLanguage = "en" | "zh";
export type CompanionAppearance = "light" | "dark" | "system";
export type CompanionScheme = Exclude<CompanionAppearance, "system">;

export const LANGUAGE_STORAGE_KEY = "lamplitisles.companion.language";
export const APPEARANCE_STORAGE_KEY = "lamplitisles.companion.appearance";

export function languagePreference(value: unknown): CompanionLanguage | undefined {
  return value === "en" || value === "zh" ? value : undefined;
}
export function appearancePreference(value: unknown): CompanionAppearance | undefined {
  return value === "light" || value === "dark" || value === "system" ? value : undefined;
}
export function preferredLanguage(languages: readonly string[] | undefined): CompanionLanguage {
  for (const language of languages ?? []) {
    const normalized = language.toLowerCase();
    if (normalized.startsWith("zh")) return "zh";
    if (normalized.startsWith("en")) return "en";
  }
  return "en";
}
export function resolveScheme(appearance: CompanionAppearance, systemDark: boolean): CompanionScheme {
  return appearance === "system" ? (systemDark ? "dark" : "light") : appearance;
}
export function readPreference(key: string): string | undefined {
  try { return globalThis.localStorage?.getItem(key) ?? undefined; } catch { return undefined; }
}
export function writePreference(key: string, value: string): void {
  try { globalThis.localStorage?.setItem(key, value); } catch { /* in-memory state still applies */ }
}
export function initialPreferences(): { language: CompanionLanguage; appearance: CompanionAppearance; systemDark: boolean } {
  const language = languagePreference(readPreference(LANGUAGE_STORAGE_KEY)) ?? preferredLanguage(globalThis.navigator?.languages);
  const appearance = appearancePreference(readPreference(APPEARANCE_STORAGE_KEY)) ?? "system";
  let systemDark = false;
  try { systemDark = globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false; } catch { /* system default remains light */ }
  return { language, appearance, systemDark };
}
