import { "welcome.greeting" as welcomeGreeting } from "../src/lib/paraglide/messages.js";

// Keep a direct generated-message call in the typecheck surface: its parameter
// declaration is produced from the message resource, not the UI adapter.
void welcomeGreeting({ name: "Mica" }, { locale: "zh" });
