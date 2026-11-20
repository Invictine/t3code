import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { ProviderProbeResult } from "../providerSnapshot.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function probeGeminiBridge(input: {
  readonly port: number;
  readonly key: string;
  readonly cookiesVerified: boolean;
}): Effect.Effect<ProviderProbeResult, never, HttpClient.HttpClient> {
  const offline: ProviderProbeResult = {
    installed: false,
    version: null,
    status: "warning",
    auth: { status: "unknown" },
    message: `Gemini bridge is offline on port ${input.port}. Start it on this environment, then refresh providers.`,
  };
  const connected = { installed: true, version: null } as const;

  return Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const baseUrl = `http://127.0.0.1:${input.port}`;
    const request = (route: string) =>
      http.execute(
        HttpClientRequest.get(baseUrl + route).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${input.key}`),
        ),
      );
    // The models endpoint requires the same key OpenCode sends for generation.
    const [modelsResponse, statusResponse] = yield* Effect.all(
      [request("/v1/models"), request("/v1/status")],
      { concurrency: "unbounded" },
    );
    if ([modelsResponse, statusResponse].some(({ status }) => status === 401 || status === 403)) {
      return {
        ...connected,
        status: "warning",
        auth: { status: "unauthenticated" },
        message:
          "The Gemini bridge rejected its API key. Check GEMINI_API_KEY on this environment.",
      } satisfies ProviderProbeResult;
    }
    if (modelsResponse.status !== 200 || statusResponse.status !== 200) return offline;

    const [models, status] = yield* Effect.all([modelsResponse.json, statusResponse.json], {
      concurrency: "unbounded",
    });
    const modelList = isRecord(models) && Array.isArray(models.data) ? models.data : [];
    if (
      !isRecord(status) ||
      status.status !== "ok" ||
      !modelList.some((model: unknown) => isRecord(model) && model.id === "gemini-4-neon")
    ) {
      return {
        ...connected,
        status: "warning",
        auth: { status: "unknown" },
        message: "The local bridge did not advertise Gemini 4 Neon. Check the bridge version.",
      } satisfies ProviderProbeResult;
    }
    if (status.active_backend === "chrome") {
      const workerReady =
        status.extension_connected === true &&
        Array.isArray(status.tabs) &&
        status.tabs.some(
          (tab: unknown) => isRecord(tab) && tab.eligible === true && tab.model_selection === true,
        );
      return {
        ...connected,
        // A connected extension confirms transport, not the Google sign-in or entitlement.
        auth: { status: "unknown" },
        status: workerReady ? "ready" : "warning",
        message: workerReady
          ? "Chrome bridge connected. Gemini runs through your Chrome session in the background."
          : "Waiting for a Gemini worker. Keep Chrome running with the Gemini bridge extension enabled.",
      } satisfies ProviderProbeResult;
    }
    if (status.active_backend !== "webapi") return offline;
    if (input.cookiesVerified) {
      return {
        ...connected,
        auth: { status: "authenticated", label: "Cookie session" },
        status: "ready",
      } satisfies ProviderProbeResult;
    }
    return {
      ...connected,
      auth: { status: "unauthenticated" },
      status: "warning",
      message:
        "The bridge is using the cookie backend. Either connect a Chrome worker in Chrome mode or verify the cookie session below.",
    } satisfies ProviderProbeResult;
  }).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.timeout("3 seconds"),
    Effect.orElseSucceed(() => offline),
  );
}
