import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { probeGeminiBridge } from "./geminiBridgeStatus.ts";

const catalog = { data: [{ id: "gemini-4-neon" }] };
const bridge = (
  response: (request: HttpClientRequest.HttpClientRequest) => Response,
  cookiesVerified = false,
) =>
  probeGeminiBridge({ cookiesVerified, key: "fixture-key", port: 8100 }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => HttpClientResponse.fromWeb(request, response(request))),
      ),
    ),
  );

describe("Gemini bridge readiness", () => {
  it.effect("accepts Chrome transport without a saved cookie session", () =>
    Effect.gen(function* () {
      const routes: string[] = [];
      const result = yield* bridge((request) => {
        assert.equal(request.headers["authorization"], "Bearer fixture-key");
        const url = new URL(request.url);
        assert.equal(url.origin, "http://127.0.0.1:8100");
        routes.push(url.pathname);
        return Response.json(
          url.pathname === "/v1/models"
            ? catalog
            : {
                status: "ok",
                active_backend: "chrome",
                extension_connected: true,
                tabs: [{ eligible: true, model_selection: true }],
              },
        );
      });

      assert.sameMembers(routes, ["/v1/models", "/v1/status"]);
      assert.include(result, { installed: true, status: "ready" });
      assert.equal(result.auth.status, "unknown");
    }),
  );

  it.effect("rejects ineligible or outdated Chrome workers without falling back to cookies", () =>
    Effect.gen(function* () {
      const result = yield* bridge(
        (request) =>
          Response.json(
            request.url.endsWith("/models")
              ? catalog
              : {
                  status: "ok",
                  active_backend: "chrome",
                  extension_connected: true,
                  tabs: [
                    { eligible: false, model_selection: true },
                    { eligible: true, model_selection: false },
                  ],
                },
          ),
        true,
      );
      assert.equal(result.status, "warning");
      assert.equal(result.auth.status, "unknown");
    }),
  );

  it.effect("requires verified cookies when the bridge is in cookie mode", () =>
    Effect.gen(function* () {
      const respond = (request: HttpClientRequest.HttpClientRequest) =>
        Response.json(
          request.url.endsWith("/models") ? catalog : { status: "ok", active_backend: "webapi" },
        );
      assert.equal((yield* bridge(respond)).auth.status, "unauthenticated");
      assert.equal((yield* bridge(respond, true)).auth.status, "authenticated");
    }),
  );

  it.effect("distinguishes a rejected key from a bridge that is unavailable", () =>
    Effect.gen(function* () {
      const rejected = yield* bridge(() => new Response(null, { status: 401 }), true);
      assert.include(rejected, { installed: true, status: "warning" });
      assert.equal(rejected.auth.status, "unauthenticated");
      const unavailable = yield* bridge(() => new Response(null, { status: 503 }), true);
      assert.include(unavailable, { installed: false, status: "warning" });
      assert.equal(unavailable.auth.status, "unknown");
    }),
  );
});
