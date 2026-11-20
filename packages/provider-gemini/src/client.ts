import { GeminiSettings, ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

export const geminiClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("gemini"),
  label: "Gemini",
  modelFamilies: ["Gemini "],
  settingsSchema: GeminiSettings,
  icon: {
    viewBox: "0 0 48 48",
    fill: { light: "#4285F4", dark: "#8AB4F8" },
    paths: [
      {
        d: "M24 4c1.9 10.5 9.5 18.1 20 20-10.5 1.9-18.1 9.5-20 20C22.1 33.5 14.5 25.9 4 24 14.5 22.1 22.1 14.5 24 4Z",
      },
    ],
  },
});
