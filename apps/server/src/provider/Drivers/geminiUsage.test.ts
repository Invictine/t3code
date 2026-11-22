import { assert, describe, it } from "@effect/vitest";

import { decodeGeminiUsage } from "./geminiUsage.ts";

describe("Gemini usage decoding", () => {
  it("maps windows and preserves optional reset metadata", () => {
    const usage = decodeGeminiUsage(
      {
        checked_at: "2026-11-22T10:30:00+05:30",
        authuser: "2",
        source: "usage_page",
        windows: [
          {
            id: "session",
            kind: "session",
            label: "Session",
            used_percent: 62.5,
            window_duration_mins: 300,
            resets_at: "2026-11-22T11:00:00Z",
          },
          {
            id: "weekly",
            kind: "weekly",
            label: "Weekly",
            used_percent: 101,
          },
          { id: "unknown", kind: "monthly", label: "Ignore", used_percent: 20 },
        ],
        models: { available: ["neon"], exhausted: [] },
      },
      "2026-11-22T00:00:00.000Z",
    );

    assert.deepEqual(usage, {
      authuser: "2",
      limits: {
        checkedAt: "2026-11-22T05:00:00.000Z",
        windows: [
          {
            id: "session",
            kind: "session",
            label: "Session",
            usedPercent: 62.5,
            windowDurationMins: 300,
            resetsAt: "2026-11-22T11:00:00.000Z",
          },
          { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 100 },
        ],
      },
    });
  });

  it("keeps an unavailable source explicit and rejects unknown payloads", () => {
    assert.equal(
      decodeGeminiUsage(
        { checked_at: "2026-11-22T10:30:00Z", authuser: "0", source: "unavailable" },
        "2026-11-22T00:00:00.000Z",
      )?.limits.unavailable?.reason,
      "probeFailed",
    );
    assert.isUndefined(
      decodeGeminiUsage({ source: "other", windows: [] }, "2026-11-22T00:00:00.000Z"),
    );
  });
});
