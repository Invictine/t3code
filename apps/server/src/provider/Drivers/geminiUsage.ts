import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";

type GeminiUsageWindow = ServerProviderUsageWindow;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isoDate = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const epochMillis = Date.parse(value);
  return Number.isFinite(epochMillis)
    ? DateTime.formatIso(DateTime.makeUnsafe(epochMillis))
    : undefined;
};

/** Convert the bridge's snake_case usage payload into T3's provider usage snapshot. */
export function decodeGeminiUsage(
  payload: unknown,
  fallbackCheckedAt: string,
): { readonly authuser?: string; readonly limits: ServerProviderUsageLimits } | undefined {
  if (!isRecord(payload)) return undefined;
  const checkedAt = isoDate(payload.checked_at) ?? fallbackCheckedAt;
  const authuser = typeof payload.authuser === "string" ? payload.authuser : undefined;
  if (payload.source === "unavailable") {
    return {
      ...(authuser === undefined ? {} : { authuser }),
      limits: makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "The Gemini bridge could not read usage from the signed-in account.",
      }),
    };
  }
  if (payload.source !== "usage_page" && payload.source !== "picker") return undefined;

  const windows: GeminiUsageWindow[] = [];
  if (Array.isArray(payload.windows)) {
    for (const value of payload.windows) {
      if (
        !isRecord(value) ||
        typeof value.id !== "string" ||
        !value.id.trim() ||
        typeof value.label !== "string" ||
        !value.label.trim() ||
        (value.kind !== "session" && value.kind !== "weekly") ||
        typeof value.used_percent !== "number" ||
        !Number.isFinite(value.used_percent)
      ) {
        continue;
      }
      const percent = Math.max(0, Math.min(100, value.used_percent));
      const resetsAt = isoDate(value.resets_at);
      const duration = value.window_duration_mins;
      windows.push({
        id: value.id.trim(),
        kind: value.kind,
        label: value.label.trim(),
        usedPercent: percent,
        ...(resetsAt === undefined ? {} : { resetsAt }),
        ...(typeof duration === "number" && Number.isInteger(duration) && duration >= 0
          ? { windowDurationMins: duration }
          : {}),
      });
    }
  }
  return {
    ...(authuser === undefined ? {} : { authuser }),
    limits: { checkedAt, windows },
  };
}
