/**
 * GeminiDriver for the Gemini web app's Neon model.
 *
 * The local bridge either drives a Chrome worker or uses session cookies.
 * Readiness follows the live bridge's selected backend. The Chrome worker
 * uses its existing browser session and does not need cookies saved in T3.
 *
 * The model catalog exposes Neon. Agent execution
 * reuses the proven OpenCode adapter, spawning the native OpenCode executable
 * with a forced, Gemini-only config through `OPENCODE_CONFIG_CONTENT`.
 *
 * @module provider/Drivers/GeminiDriver
 */
import {
  GEMINI_NEON_MODEL,
  GeminiSettings,
  type OpenCodeSettings,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeOpenCodeTextGeneration } from "../../textGeneration/OpenCodeTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOpenCodeAdapter } from "../Layers/OpenCodeAdapter.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { OpenCodeRuntime } from "../opencodeRuntime.ts";
import * as OpenCodeServerOwner from "../OpenCodeServerOwner.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  type ProviderProbeResult,
} from "../providerSnapshot.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { probeGeminiBridge } from "./geminiBridgeStatus.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER_KIND = ProviderDriverKind.make("gemini");
const decodeSettings = Schema.decodeSync(GeminiSettings);

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

const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

const GEMINI_API_KEY = "gemini-local";
const DEFAULT_BRIDGE_PORT = 8100;

function resolvePort(raw: string | undefined): number {
  const port = Number.parseInt(raw?.trim() ?? "", 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_BRIDGE_PORT;
}

/**
 * Point the OpenCode v1 server at the local bridge and enable only Gemini.
 */
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
        models: {
          neon: { name: "Gemini 4 Neon", tool_call: true },
        },
      },
    },
  });
}

export type GeminiDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | OpenCodeRuntime
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const GeminiDriver: ProviderDriver<GeminiSettings, GeminiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Gemini", supportsMultipleInstances: true },
  configSchema: GeminiSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const eventLoggers = yield* ProviderEventLoggers;
      const serverSettings = yield* ServerSettingsService;
      const fs = yield* FileSystem.FileSystem;
      const http = yield* HttpClient.HttpClient;
      const path = yield* Path.Path;
      const settings = { ...config, enabled } satisfies GeminiSettings;
      const port = resolvePort(settings.port);
      const hasCookies = settings.psid.trim().length > 0 && settings.psidts.trim().length > 0;
      // Cookies on disk are only a claim. `verified` is set by the sign-in dialog
      // only after the bridge confirmed them live with Google, so never present
      // merely having cookies as an authenticated / ready connection.
      const verified = hasCookies && settings.verified;

      // The forced config is injected into the process environment of the
      // OpenCode server the adapter spawns. Cookies are intentionally not
      // included: the local bridge owns them.
      const instanceEnv = mergeProviderInstanceEnvironment(environment);
      const apiKey = instanceEnv.GEMINI_API_KEY?.trim() || GEMINI_API_KEY;

      // OpenCode v1 MERGES OPENCODE_CONFIG_CONTENT with the global config and
      // does not recognize OPENCODE_CONFIG_PROJECT_DISABLE. Without isolation
      // the spawned server reads ~/.config/opencode (which can contain keys
      // from a newer OpenCode) and the shared opencode.db, then exits during
      // startup. Point every XDG root at a Gemini-owned directory and use the
      // real project-config flag. Provider-instance env vars still win so a
      // user can override these explicitly.
      const geminiHome =
        instanceEnv.T3CODE_HOME?.trim() ||
        path.join(
          instanceEnv.USERPROFILE || process.env.USERPROFILE || ".",
          ".t3-gemini",
        );
      const processEnv: NodeJS.ProcessEnv = {
        XDG_CONFIG_HOME: path.join(geminiHome, "opencode-config"),
        XDG_DATA_HOME: path.join(geminiHome, "opencode-data"),
        XDG_STATE_HOME: path.join(geminiHome, "opencode-state"),
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        ...instanceEnv,
        OPENCODE_CONFIG_CONTENT: buildGeminiConfigContent(port, apiKey),
      };

      const configuredBinary = settings.binaryPath.trim() || "opencode";
      const editionBinary =
        configuredBinary === "opencode" && process.platform === "win32" && instanceEnv.LOCALAPPDATA
          ? path.join(
              instanceEnv.LOCALAPPDATA,
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

      const openCodeSettings: OpenCodeSettings = {
        enabled: settings.enabled,
        binaryPath,
        serverUrl: "",
        serverPassword: "",
        customModels: [],
      };

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

      const makeSnapshot = (checkedAt: string, probe: ProviderProbeResult) =>
        buildServerProvider({
          driver: DRIVER_KIND,
          presentation: {
            displayName: "Gemini",
            showInteractionModeToggle: false,
          },
          enabled: settings.enabled,
          checkedAt,
          models: GEMINI_MODELS,
          slashCommands: [COMPACT_SLASH_COMMAND],
          probe,
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
        const now = yield* DateTime.now;
        return stampIdentity(makeSnapshot(DateTime.formatIso(now), probe));
      });

      const adapter = yield* makeOpenCodeAdapter(openCodeSettings, {
        instanceId,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });

      const serverOwner = yield* OpenCodeServerOwner.make({
        binaryPath: openCodeSettings.binaryPath,
        directory: serverConfig.cwd,
        environment: processEnv,
      });
      const textGeneration = yield* makeOpenCodeTextGeneration(openCodeSettings).pipe(
        Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, serverOwner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource<GeminiSettings>(
        settings,
        serverSettings,
      );
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

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled: settings.enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
