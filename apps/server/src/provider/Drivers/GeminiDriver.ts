/**
 * GeminiDriver — first-class provider for the Gemini web app's Argon /
 * Hydrogen models.
 *
 * Google exposes no official OAuth for these web-app-only models. Sign-in is
 * represented by the two session cookies the web app itself uses; they live in
 * the provider-instance settings and are never logged by this driver. The
 * settings dialog pushes them to the running bridge at sign-in, which persists
 * them to its own .env, so this driver only needs to point OpenCode at that
 * bridge.
 *
 * The model catalog is static: the two supported models are supplied by this
 * driver rather than by the server-controlled model manifest. Agent execution
 * reuses the proven OpenCode adapter, spawning the native OpenCode executable
 * with a forced, Gemini-only config through `OPENCODE_CONFIG_CONTENT`.
 *
 * @module provider/Drivers/GeminiDriver
 */
import {
  GEMINI_ARGON_MODEL,
  GEMINI_HYDROGEN_MODEL,
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
import { buildServerProvider, COMPACT_SLASH_COMMAND } from "../providerSnapshot.ts";
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
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER_KIND = ProviderDriverKind.make("gemini");
const decodeSettings = Schema.decodeSync(GeminiSettings);

/** The only two models this provider offers. No server manifest is consulted. */
export const GEMINI_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: GEMINI_ARGON_MODEL,
    name: "Gemini 4 Argon",
    shortName: "Argon",
    subProvider: "gemini-app",
    isCustom: false,
    isDefault: true,
    capabilities: null,
  },
  {
    slug: GEMINI_HYDROGEN_MODEL,
    name: "Gemini 4 Hydrogen",
    shortName: "Hydrogen",
    subProvider: "gemini-app",
    isCustom: false,
    capabilities: null,
  },
];

const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

/** Native OpenCode executable proven by the gemini-jio-argon harness. */
const DEFAULT_GEMINI_BINARY_PATH =
  "C:\\Users\\aniru\\AppData\\Local\\hermes\\node\\node_modules\\@opencode\\cli\\bin\\opencode.exe";
const GEMINI_API_KEY = "gemini-local";
const DEFAULT_BRIDGE_PORT = 8100;

function resolvePort(raw: string | undefined): number {
  const port = Number.parseInt(raw?.trim() ?? "", 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_BRIDGE_PORT;
}

/**
 * Build the exact one-line OpenCode config the harness forces through
 * `OPENCODE_CONFIG_CONTENT`. Only the port is configurable; every other field
 * is pinned so the agent can never reach another provider.
 */
export function buildGeminiConfigContent(port: number): string {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: GEMINI_ARGON_MODEL,
    providers: {
      "gemini-app": {
        name: "Gemini App",
        package: "@opencode/ai/providers/openai-compatible",
        settings: {
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKey: GEMINI_API_KEY,
        },
        models: {
          argon: { name: "Gemini 4 Argon" },
          hydrogen: { name: "Gemini 4 Hydrogen" },
        },
      },
    },
  });
}

export type GeminiDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | Crypto.Crypto
  | FileSystem.FileSystem
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
      const settings = { ...config, enabled } satisfies GeminiSettings;
      const port = resolvePort(settings.port);
      const configured = settings.psid.trim().length > 0 && settings.psidts.trim().length > 0;

      // The forced config is injected into the process environment of the
      // OpenCode server the adapter spawns. Cookies are intentionally not
      // included: the local bridge owns them.
      const processEnv: NodeJS.ProcessEnv = {
        ...mergeProviderInstanceEnvironment(environment),
        OPENCODE_CONFIG_CONTENT: buildGeminiConfigContent(port),
        OPENCODE_CONFIG_PROJECT_DISABLE: "1",
      };

      const openCodeSettings: OpenCodeSettings = {
        enabled: settings.enabled,
        binaryPath: settings.binaryPath.trim() || DEFAULT_GEMINI_BINARY_PATH,
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

      const makeSnapshot = (checkedAt: string) =>
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
          probe: {
            installed: configured,
            version: null,
            status: !settings.enabled || !configured ? "warning" : "ready",
            auth: { status: configured ? "authenticated" : "unauthenticated" },
            ...(!settings.enabled
              ? { message: "Gemini is disabled in T3 Code settings." }
              : configured
                ? {}
                : {
                    message: "Add your Gemini web-app cookies in provider settings to connect.",
                  }),
          },
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
        initialSnapshot: () =>
          Effect.map(DateTime.now, (now) => stampIdentity(makeSnapshot(DateTime.formatIso(now)))),
        checkProvider: Effect.map(DateTime.now, (now) =>
          stampIdentity(makeSnapshot(DateTime.formatIso(now))),
        ),
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
