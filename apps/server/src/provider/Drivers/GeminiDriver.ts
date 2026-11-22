/** Gemini web-app provider backed by the local OpenCode-compatible bridge. */
import {
  GEMINI_NEON_MODEL,
  GeminiSettings,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  buildServerProvider,
  type ProviderProbeResult,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as OpenCodeServerOwner from "@t3tools/provider-opencode/server/OpenCodeServerOwner";
import {
  makeOpenCodeAdapterV2,
  type OpenCodeAdapterV2DriverEnv,
} from "@t3tools/provider-opencode/server/adapter";
import { OpenCodeSettings } from "@t3tools/provider-opencode/settings";
import { makeOpenCodeTextGeneration } from "@t3tools/provider-opencode/server/textGeneration";
import { probeGeminiBridge } from "./geminiBridgeStatus.ts";
import { decodeGeminiUsage } from "./geminiUsage.ts";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";

const DRIVER_KIND = ProviderDriverKind.make("gemini");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});
const decodeSettings = Schema.decodeSync(GeminiSettings);
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

export const GEMINI_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: GEMINI_NEON_MODEL,
    name: "Gemini 4 Neon",
    shortName: "Neon",
    subProvider: "gemini-app",
    isCustom: false,
    isDefault: true,
    capabilities: null,
  },
];

const EXACT_MODELS = [
  ...GEMINI_MODELS,
  ...(["Argon", "Hydrogen"] as const).map((name) => ({
    slug: `gemini-app/${name.toLowerCase()}`,
    name: `Gemini 4 ${name}`,
    shortName: name,
    subProvider: "gemini-app",
    isCustom: false,
    isDefault: false,
    capabilities: null,
  })),
] satisfies ReadonlyArray<ServerProviderModel>;

const GEMINI_API_KEY = "gemini-local";
const DEFAULT_BRIDGE_PORT = 8100;

function resolvePort(raw: string | undefined): number {
  const port = Number.parseInt(raw?.trim() ?? "", 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_BRIDGE_PORT;
}

/** Configure OpenCode to use only the local Gemini bridge. */
export function buildGeminiConfigContent(port: number, apiKey = GEMINI_API_KEY): string {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: GEMINI_NEON_MODEL,
    enabled_providers: ["gemini-app"],
    provider: {
      "gemini-app": {
        name: "Gemini App",
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKey,
        },
        models: Object.fromEntries(
          EXACT_MODELS.map(({ slug, name }) => [slug.split("/")[1], { name, tool_call: true }]),
        ),
      },
    },
  });
}

export type GeminiDriverEnv =
  | OpenCodeAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

export const GeminiDriver: ProviderDriver<GeminiSettings, GeminiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Gemini", supportsMultipleInstances: true },
  configSchema: GeminiSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("GeminiDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
      const fs = yield* FileSystem.FileSystem;
      const http = yield* HttpClient.HttpClient;
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const settings = { ...config, enabled } satisfies GeminiSettings;
      const port = resolvePort(settings.port);
      const hasCookies = settings.psid.trim().length > 0 && settings.psidts.trim().length > 0;
      const verified = hasCookies && settings.verified;

      const instanceEnvironment = yield* mergeProviderInstanceEnvironment(environment);
      const apiKey = instanceEnvironment.GEMINI_API_KEY?.trim() || GEMINI_API_KEY;
      const geminiHome =
        instanceEnvironment.T3CODE_HOME?.trim() ||
        path.join(instanceEnvironment.USERPROFILE || ".", ".t3-gemini");
      const processEnv: NodeJS.ProcessEnv = {
        XDG_CONFIG_HOME: path.join(geminiHome, "opencode-config"),
        XDG_DATA_HOME: path.join(geminiHome, "opencode-data"),
        XDG_STATE_HOME: path.join(geminiHome, "opencode-state"),
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        ...instanceEnvironment,
        OPENCODE_CONFIG_CONTENT: buildGeminiConfigContent(port, apiKey),
      };

      const configuredBinary = settings.binaryPath.trim() || "opencode";
      const editionBinary =
        configuredBinary === "opencode" && process.platform === "win32" && instanceEnvironment.LOCALAPPDATA
          ? path.join(
              instanceEnvironment.LOCALAPPDATA,
              "T3 Code (Gemini)",
              "runtime",
              "opencode",
              "node_modules",
              `opencode-windows-${process.arch}`,
              "bin",
              "opencode.exe",
            )
          : undefined;
      const binaryPath =
        editionBinary && (yield* fs.exists(editionBinary).pipe(Effect.orElseSucceed(() => false)))
          ? editionBinary
          : configuredBinary;
      const openCodeSettings = decodeOpenCodeSettings({
        enabled,
        binaryPath,
        serverUrl: "",
        serverPassword: "",
        customModels: [],
      });

      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const checkProvider = Effect.gen(function* () {
        const probe: ProviderProbeResult = settings.enabled
          ? yield* probeGeminiBridge({ port, key: apiKey, cookiesVerified: verified }).pipe(
              Effect.provideService(HttpClient.HttpClient, http),
            )
          : {
              installed: false,
              version: null,
              status: "warning",
              auth: { status: "unknown" },
              message: "Gemini is disabled in T3 Code settings.",
            };
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        const usageProbe: ProviderProbeResult["usageLimits"] =
          probe.status !== "ready"
            ? undefined
            : yield* Effect.gen(function* () {
                const response = yield* http.execute(
                  HttpClientRequest.get(`http://127.0.0.1:${port}/v1/usage`).pipe(
                    HttpClientRequest.setHeader("authorization", "Bearer " + apiKey),
                  ),
                );
                if (response.status !== 200) {
                  return makeUnavailableUsageLimits({
                    checkedAt,
                    reason: "probeFailed",
                    message: "The Gemini bridge could not read account usage.",
                  });
                }
                const decoded = decodeGeminiUsage(yield* response.json, checkedAt);
                return (
                  decoded?.limits ??
                  makeUnavailableUsageLimits({
                    checkedAt,
                    reason: "probeFailed",
                    message: "The Gemini bridge returned an unreadable usage report.",
                  })
                );
              }).pipe(
                Effect.timeout("2 seconds"),
                Effect.orElseSucceed(() =>
                  makeUnavailableUsageLimits({
                    checkedAt,
                    reason: "probeFailed",
                    message: "The Gemini bridge timed out while reading account usage.",
                  }),
                ),
              );
        const enrichedProbe = usageProbe === undefined ? probe : { ...probe, usageLimits: usageProbe };
        const models =
          probe.status === "ready"
            ? yield* Effect.gen(function* () {
                const response = yield* http.execute(
                  HttpClientRequest.get("http://127.0.0.1:" + port + "/v1/accounts").pipe(
                    HttpClientRequest.setHeader("authorization", "Bearer " + apiKey),
                  ),
                );
                if (response.status !== 200) return GEMINI_MODELS;
                const catalog = (yield* response.json) as {
                  default_authuser: string;
                  accounts: ReadonlyArray<{ authuser: string; picker_models: string[] | null }>;
                };
                const offered = catalog.accounts.find(
                  (account) => account.authuser === catalog.default_authuser,
                )?.picker_models;
                if (!offered) return GEMINI_MODELS;
                return EXACT_MODELS.filter(({ slug }) => {
                  const model = slug.slice("gemini-app/".length);
                  return offered.includes(model) || offered.includes("gemini-4-" + model);
                });
              }).pipe(
                Effect.timeout("2 seconds"),
                Effect.orElseSucceed(() => GEMINI_MODELS),
              )
            : GEMINI_MODELS;
        const now = yield* DateTime.now;
        return stampIdentity(
          buildServerProvider({
            driver: DRIVER_KIND,
            presentation: { displayName: "Gemini", showInteractionModeToggle: false },
            enabled: settings.enabled,
            checkedAt: DateTime.formatIso(now),
            models,
            probe: enrichedProbe,
          }),
        );
      });
      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(settings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<GeminiSettings>>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () => checkProvider,
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Gemini snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      const serverOwner = yield* OpenCodeServerOwner.make({
        binaryPath: openCodeSettings.binaryPath,
        directory: host.paths.cwd,
        environment: processEnv,
      });
      const textGeneration = yield* makeOpenCodeTextGeneration(openCodeSettings).pipe(
        Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, serverOwner),
      );
      const orchestrationAdapter = yield* makeOpenCodeAdapterV2({
        instanceId,
        settings: openCodeSettings,
        environment: processEnv,
        driver: DRIVER_KIND,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Gemini orchestration adapter.",
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
  }),
};
