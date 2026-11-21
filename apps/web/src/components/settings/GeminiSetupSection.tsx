/**
 * Gemini cookie sign-in.
 *
 * Google has no official OAuth for the web app's Neon model,
 * so the correct analog to Antigravity's browser flow is a dialog where the
 * user pastes the two `__Secure-1PSID*` cookies from a signed-in
 * gemini.google.com session. The values are stored as provider-instance
 * settings, never logged, and validated against the local bridge when it is
 * reachable.
 */
import { useState } from "react";

import { Button } from "../ui/button";
import { GeminiAccountControls } from "./GeminiBridgeControls";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export interface GeminiCredentials {
  readonly port: string;
  readonly psid: string;
  readonly psidts: string;
  /** True only after the bridge confirmed the cookies live with Google. */
  readonly verified: boolean;
}

const API_KEY = "gemini-local";

function readGeminiCredentials(config: unknown): GeminiCredentials {
  const raw =
    config !== null && typeof config === "object" ? (config as Record<string, unknown>) : {};
  const stringValue = (key: string) =>
    typeof raw[key] === "string" ? (raw[key] as string).trim() : "";
  return {
    port: stringValue("port") || "8100",
    psid: stringValue("psid"),
    psidts: stringValue("psidts"),
    verified: raw.verified === true,
  };
}

function isValidPort(port: string): boolean {
  const value = Number.parseInt(port, 10);
  return Number.isInteger(value) && value > 0 && value <= 65_535;
}

/** Result of one attempt to push cookies to the bridge and verify them live. */
type BridgeVerifyResult =
  | { readonly ok: true; readonly models: unknown }
  | { readonly ok: false; readonly offline: true }
  | {
      readonly ok: false;
      readonly offline: false;
      readonly status: number;
      readonly detail: string;
    };

/**
 * Push cookies into the running bridge and verify them with Google. Isolated so
 * both the sign-in dialog and the offline "Apply saved cookies" retry use the
 * exact same path and the same honesty about what succeeded.
 */
async function verifyWithBridge(
  port: string,
  psid: string,
  psidts: string,
): Promise<BridgeVerifyResult> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/auth/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ psid, psidts }),
    });
    if (!response.ok) {
      const detail = (await response.text()).trim().slice(0, 300);
      return { ok: false, offline: false, status: response.status, detail };
    }
    // Newer bridges report which Gemini 4 app models the account actually has.
    // Older ones don't; that's fine, so parse defensively and never fail sign-in.
    let models: unknown = undefined;
    try {
      const body = (await response.json()) as { models?: unknown } | null;
      models = body?.models ?? undefined;
    } catch {
      // Non-JSON body from an older bridge — ignore.
    }
    return { ok: true, models };
  } catch {
    return { ok: false, offline: true };
  }
}

/** Short, honest note about the bridge's discovered model availability. */
function describeModelAvailability(models: unknown): string {
  if (models === null || typeof models !== "object") return "";
  const raw = models as Record<string, unknown>;
  if (raw.neon === true) return " The bridge reports that Neon is available.";
  if (raw.neon === false) return " The bridge reports that Neon is unavailable.";
  return "";
}

interface GeminiSetupSectionProps {
  readonly config: unknown;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly onEnable: () => void;
  readonly onCatalogChange: () => void;
  readonly onCredentialsChange: (credentials: GeminiCredentials) => void;
}

export function GeminiSetupSection(props: GeminiSetupSectionProps) {
  const saved = readGeminiCredentials(props.config);
  const hasCookies = saved.psid.length > 0 && saved.psidts.length > 0;
  const verified = hasCookies && saved.verified;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<GeminiCredentials>(saved);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  function openDialog() {
    setDraft(saved);
    setError(null);
    setNotice(null);
    setOpen(true);
  }

  async function verifyAndSave() {
    if (!draft.psid.trim() || !draft.psidts.trim()) {
      setError("Paste both __Secure-1PSID and __Secure-1PSIDTS.");
      return;
    }
    if (!isValidPort(draft.port)) {
      setError("Bridge port must be a number between 1 and 65535.");
      return;
    }
    const port = draft.port.trim();
    const psid = draft.psid.trim();
    const psidts = draft.psidts.trim();
    setVerifying(true);
    setError(null);
    const result = await verifyWithBridge(port, psid, psidts);
    setVerifying(false);

    if (!result.ok) {
      if (result.offline) {
        // A stopped bridge must not block saving: keep the credentials locally so
        // they are ready for the next launch, but label them UNVERIFIED.
        props.onCredentialsChange({ port, psid, psidts, verified: false });
        setNotice(
          "Bridge is not reachable. Cookies were saved locally but NOT verified with Google. " +
            "Start the bridge, then use 'Apply saved cookies' to confirm them.",
        );
        setOpen(false);
      } else {
        // Never persist cookies Google/the bridge rejected: doing so would
        // replace a working sign-in with a bad one. Keep the dialog open.
        setError(
          result.detail
            ? `Verification failed (${result.status}): ${result.detail}`
            : `Verification failed (${result.status}). Nothing was saved. Check the bridge log.`,
        );
      }
      return;
    }

    // 2xx means the bridge contacted Google successfully.
    props.onCredentialsChange({ port, psid, psidts, verified: true });
    setNotice(
      "Signed in. The bridge verified these cookies live with Google and is using them." +
        describeModelAvailability(result.models),
    );
    setOpen(false);
  }

  /** Re-apply cookies saved while the bridge was offline (offline recovery). */
  async function retrySaved() {
    if (!hasCookies) return;
    setVerifying(true);
    setError(null);
    setNotice(null);
    const result = await verifyWithBridge(saved.port, saved.psid, saved.psidts);
    setVerifying(false);

    if (result.ok) {
      props.onCredentialsChange({ ...saved, verified: true });
      setNotice(
        "Applied saved cookies. The bridge verified them live with Google." +
          describeModelAvailability(result.models),
      );
    } else if (result.offline) {
      setNotice(
        "Bridge is still not reachable. Saved cookies are unchanged and remain unverified. " +
          "Start the bridge and try again.",
      );
    } else {
      // Do not clear saved cookies on a rejection — the session may have simply
      // gone stale. Stay honest about the state and let the user update them.
      setNotice(
        `Google/bridge rejected the saved cookies (${result.detail}). They remain saved but ` +
          "unverified; use 'Update cookies' if they are stale.",
      );
    }
  }

  return (
    <section aria-label="Gemini setup" className="grid gap-3 text-xs">
      <p>
        Gemini 4 Neon uses the bridge on this environment. In Chrome mode, keep Chrome running with
        the Gemini bridge extension enabled and your Gemini account signed in. Available models
        depend on your Gemini account.
      </p>
      {!props.enabled ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">Enable it to use it in threads.</span>
          {!props.readOnly ? (
            <Button size="xs" variant="outline" onClick={props.onEnable}>
              Enable Gemini
            </Button>
          ) : null}
        </div>
      ) : null}
      {props.readOnly ? (
        <p className="text-muted-foreground">This connection cannot change provider setup.</p>
      ) : (
        <div className="grid gap-2 border-t border-border/60 pt-3">
          <p className="font-medium">Cookie backend (optional)</p>
          <p role="status" className="text-muted-foreground">
            {verified
              ? "The bridge previously verified these cookies with Google."
              : hasCookies
                ? "Cookies saved but NOT yet verified with Google. With the bridge running, use 'Apply saved cookies' to confirm them."
                : "Save cookies only if the bridge is configured for the cookie backend."}
          </p>
          {notice ? (
            <p className="text-muted-foreground [overflow-wrap:anywhere]">{notice}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="outline" onClick={openDialog}>
              {hasCookies ? "Update cookies" : "Set up cookies"}
            </Button>
            {hasCookies && !verified ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => void retrySaved()}
                disabled={verifying}
              >
                {verifying ? "Checking…" : "Apply saved cookies"}
              </Button>
            ) : null}
            {hasCookies ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  props.onCredentialsChange({
                    port: saved.port,
                    psid: "",
                    psidts: "",
                    verified: false,
                  });
                  setNotice(null);
                }}
              >
                Disconnect
              </Button>
            ) : null}
          </div>
        </div>
      )}

      {!props.readOnly ? (
        <GeminiAccountControls port={saved.port} onCatalogChange={props.onCatalogChange} />
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Sign in to Gemini</DialogTitle>
            <DialogDescription>
              In Chrome, open gemini.google.com, press F12 → Application → Cookies, and copy the
              values of <code>__Secure-1PSID</code> and <code>__Secure-1PSIDTS</code>. Google has no
              official OAuth for these web-app models, so these cookies are the credential. With the
              bridge running, <strong>Verify &amp; save</strong> checks them live against Google.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="gemini-psid">__Secure-1PSID</Label>
              <Input
                id="gemini-psid"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={draft.psid}
                maxLength={4096}
                placeholder="Paste cookie value"
                onChange={(event) => setDraft({ ...draft, psid: event.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="gemini-psidts">__Secure-1PSIDTS</Label>
              <Input
                id="gemini-psidts"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={draft.psidts}
                maxLength={4096}
                placeholder="Paste cookie value"
                onChange={(event) => setDraft({ ...draft, psidts: event.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="gemini-port">Bridge port</Label>
              <Input
                id="gemini-port"
                inputMode="numeric"
                autoComplete="off"
                value={draft.port}
                maxLength={5}
                placeholder="8100"
                onChange={(event) => setDraft({ ...draft, port: event.target.value })}
              />
            </div>
            <p className="text-muted-foreground">
              Credentials are stored as provider settings on this environment and are never logged.
              They are validated against the local bridge, which sends them to Google. If
              verification fails, nothing is saved. This is an unofficial, reverse-engineered path
              that may violate Google&apos;s Terms of Service — prefer a secondary account.
            </p>
            {error ? (
              <p role="alert" className="text-destructive [overflow-wrap:anywhere]">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button size="xs" variant="ghost" onClick={() => setOpen(false)} disabled={verifying}>
              Cancel
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void verifyAndSave()}
              disabled={verifying}
            >
              {verifying ? "Checking…" : "Verify & save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </section>
  );
}
