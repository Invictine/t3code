/**
 * Gemini cookie sign-in.
 *
 * Google has no official OAuth for the web-app-only Argon / Hydrogen models,
 * so the correct analog to Antigravity's browser flow is a dialog where the
 * user pastes the two `__Secure-1PSID*` cookies from a signed-in
 * gemini.google.com session. The values are stored as provider-instance
 * settings, never logged, and validated against the local bridge when it is
 * reachable.
 */
import { useState } from "react";

import { Button } from "../ui/button";
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
}

const API_KEY = "gemini-local";

export function readGeminiCredentials(config: unknown): GeminiCredentials {
  const raw = config !== null && typeof config === "object" ? (config as Record<string, unknown>) : {};
  const stringValue = (key: string) =>
    typeof raw[key] === "string" ? (raw[key] as string).trim() : "";
  return {
    port: stringValue("port") || "8100",
    psid: stringValue("psid"),
    psidts: stringValue("psidts"),
  };
}

function isValidPort(port: string): boolean {
  const value = Number.parseInt(port, 10);
  return Number.isInteger(value) && value > 0 && value <= 65_535;
}

interface GeminiSetupSectionProps {
  readonly config: unknown;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly onEnable: () => void;
  readonly onCredentialsChange: (credentials: GeminiCredentials) => void;
}

export function GeminiSetupSection(props: GeminiSetupSectionProps) {
  const saved = readGeminiCredentials(props.config);
  const connected = saved.psid.length > 0 && saved.psidts.length > 0;
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
    try {
      // Push the cookies into the running bridge so they take effect without a
      // restart. The bridge never echoes them back in its response or errors.
      const response = await fetch(`http://127.0.0.1:${port}/v1/auth/session`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ psid, psidts }),
      });
      if (!response.ok) {
        const detail = (await response.text()).trim().slice(0, 300);
        setError(
          detail
            ? `Bridge rejected the cookies (${response.status}): ${detail}`
            : `Bridge rejected the cookies (${response.status}). Check the bridge log.`,
        );
        return;
      }
    } catch {
      // A stopped bridge must not block saving: keep the credentials locally so
      // they are ready for the next launch, with a clear notice about it.
      props.onCredentialsChange({ port, psid, psidts });
      setNotice("Bridge is not reachable right now. Cookies were saved; start the bridge to use them.");
      setOpen(false);
      return;
    } finally {
      setVerifying(false);
    }
    props.onCredentialsChange({ port, psid, psidts });
    setNotice("Signed in. The live bridge is now using these cookies.");
    setOpen(false);
  }

  return (
    <section aria-label="Gemini setup" className="grid gap-3 text-xs">
      <p>Gemini runs on a local bridge on this environment.</p>
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
          <p className="font-medium">Google account</p>
          <p role="status" className="text-muted-foreground">
            {connected
              ? "Signed in with Gemini web-app cookies."
              : "Paste the session cookies from a signed-in gemini.google.com tab."}
          </p>
          {notice ? <p className="text-muted-foreground [overflow-wrap:anywhere]">{notice}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="outline" onClick={openDialog}>
              {connected ? "Update cookies" : "Sign in"}
            </Button>
            {connected ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  props.onCredentialsChange({ port: saved.port, psid: "", psidts: "" });
                  setNotice(null);
                }}
              >
                Disconnect
              </Button>
            ) : null}
          </div>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Sign in to Gemini</DialogTitle>
            <DialogDescription>
              In Chrome, open gemini.google.com, press F12 → Application → Cookies, and copy the
              values of <code>__Secure-1PSID</code> and <code>__Secure-1PSIDTS</code>. Google has no
              official OAuth for these web-app models, so these cookies are the credential.
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
                maxLength={16_384}
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
                maxLength={16_384}
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
              They are validated against the local bridge, which sends them to Google.
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
            <Button size="xs" variant="outline" onClick={() => void verifyAndSave()} disabled={verifying}>
              {verifying ? "Checking…" : "Verify & save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </section>
  );
}
