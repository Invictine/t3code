export const GEMINI_DESKTOP_NAME = "T3 Code (Gemini)";
export const GEMINI_DESKTOP_ID = "com.invictine.t3code.gemini";
export const GEMINI_DESKTOP_SCHEME = "t3code-gemini";
export const GEMINI_DESKTOP_HOME = ".t3-gemini";
export const GEMINI_DESKTOP_PACKAGE = "t3code-gemini";

export function isGeminiDesktopVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-gemini(?:\.\d+)?$/.test(version);
}
