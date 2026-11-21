import { useEffect, useState } from "react";
import { Button } from "../ui/button";

const models = ["neon", "argon", "hydrogen"] as const;
type Model = (typeof models)[number];
const label = (model: string) =>
  model.replace(/^gemini-4-/, "").replace(/^./, (letter) => letter.toUpperCase());

type Account = {
  authuser: string;
  eligible: boolean;
  picker_models: string[] | null;
  picker_options?: string[] | null;
  last_success?: Record<string, string>;
};
type Accounts = { default_authuser: string; accounts: Account[] };
type Ticket = {
  id: string;
  status: string;
  stage: string;
  model: string | null;
  authuser: string | null;
  session_affinity: string | null;
  created_at: number;
  tabId: string | null;
  position?: number;
};
type Queue = { active: Ticket | null; queued: Ticket[] };
type ModelCheck = { ok: boolean; stage: string; message: string };

async function bridge<T>(port: string, route: string, init?: RequestInit): Promise<T> {
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("Invalid Gemini bridge port.");
  }
  const response = await fetch(`http://127.0.0.1:${port}/v1/${route}`, {
    ...init,
    headers: { Authorization: "Bearer gemini-local", ...init?.headers },
    signal: init?.signal ?? AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    throw new Error(
      typeof data?.detail === "string" ? data.detail : `Bridge returned ${response.status}.`,
    );
  }
  return (await response.json()) as T;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function GeminiAccountControls({
  port,
  onCatalogChange,
}: {
  port: string;
  onCatalogChange: () => void;
}) {
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  const [model, setModel] = useState<Model>("neon");
  const [pending, setPending] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    void bridge<Accounts>(port, "accounts", {
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
    }).then(setAccounts, () => undefined);
    return () => abort.abort();
  }, [port]);

  async function run(action: string, fn: () => Promise<void>) {
    setPending(action);
    setStatus("");
    try {
      await fn();
    } catch (error) {
      setStatus(message(error));
    } finally {
      setPending(null);
    }
  }

  const account = accounts?.accounts.find((entry) => entry.authuser === accounts.default_authuser);
  return (
    <div className="grid gap-2 rounded-lg border border-border/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">
          Google account
          <select
            className="rounded border border-border bg-background p-1"
            value={accounts?.default_authuser ?? ""}
            disabled={Boolean(pending) || !accounts}
            onChange={(event) => {
              const authuser = event.target.value;
              void run("Switching account…", async () => {
                await bridge(port, "accounts/default", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ authuser }),
                });
                setAccounts(await bridge<Accounts>(port, "accounts"));
                onCatalogChange();
                setStatus(`Account ${authuser} selected for new requests.`);
              });
            }}
          >
            {account == null ? (
              <option value={accounts?.default_authuser ?? ""}>Waiting for Chrome</option>
            ) : null}
            {accounts?.accounts.map((entry) => (
              <option key={entry.authuser} value={entry.authuser}>
                Account {entry.authuser}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="xs"
          variant="outline"
          disabled={Boolean(pending)}
          onClick={() =>
            void run("Refreshing accounts…", async () => {
              setAccounts(
                await bridge<Accounts>(port, "accounts?refresh=true", {
                  signal: AbortSignal.timeout(20000),
                }),
              );
              onCatalogChange();
            })
          }
        >
          Refresh accounts
        </Button>
        <a
          href="https://gemini.google.com/app"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          Open Gemini to sign in
        </a>
      </div>
      <ul className="grid gap-1 text-muted-foreground">
        {models.map((item) => {
          const available = account?.picker_models?.some((entry) => label(entry) === label(item));
          const since =
            account?.last_success?.[item] ?? account?.last_success?.[`gemini-4-${item}`];
          return (
            <li key={item}>
              {label(item)} ·{" "}
              {available
                ? "Offered"
                : account?.picker_models
                  ? "Unavailable on this account"
                  : "Picker availability unknown"}
              {since ? ` · Last reply ${new Date(since).toLocaleString()}` : ""}
            </li>
          );
        })}
      </ul>
      {account?.picker_models?.length === 0 && account.picker_options?.length ? (
        <p className="text-muted-foreground">Gemini shows {account.picker_options.join(", ")}.</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">
          Model to test
          <select
            className="rounded border border-border bg-background p-1"
            value={model}
            onChange={(event) => setModel(event.target.value as Model)}
          >
            {models.map((item) => (
              <option key={item} value={item}>
                {label(item)}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="xs"
          variant="outline"
          disabled={Boolean(pending)}
          onClick={() =>
            void run("Testing OpenCode file read…", async () => {
              const result = await bridge<ModelCheck>(port, `model-check/${model}`, {
                method: "POST",
                signal: AbortSignal.timeout(365000),
              });
              setStatus(
                result.ok ? result.message : `Failed at ${result.stage}. ${result.message}`,
              );
              setAccounts(await bridge<Accounts>(port, "accounts"));
            })
          }
        >
          Test this model
        </Button>
        <span role="status">{pending ?? status}</span>
      </div>
    </div>
  );
}

const stages: Record<string, string> = {
  queued: "Queued",
  moved_ahead: "Queued",
  starting: "Starting",
  waiting_for_tab: "Waiting for Chrome",
  dispatching: "Preparing Gemini",
  selecting_model: "Selecting model",
  awaiting_response: "Waiting for Gemini",
  reading_response: "Reading Gemini’s reply",
  recovering_response: "Recovering Gemini’s reply",
};

export function GeminiRequestStatus({
  port,
  session,
}: {
  port: string;
  session?: string | null | undefined;
}) {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    let timer: number;
    async function poll() {
      try {
        const snapshot = await bridge<Queue>(port, "requests", {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
        });
        if (!abort.signal.aborted) setQueue(snapshot);
      } catch {
        if (!abort.signal.aborted) setQueue(null);
      } finally {
        if (!abort.signal.aborted) timer = window.setTimeout(() => void poll(), 1000);
      }
    }
    void poll();
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [port]);

  async function act(id: string, action: string) {
    setPending(true);
    setError("");
    try {
      await bridge(port, `requests/${encodeURIComponent(id)}/${action}`, { method: "POST" });
      setQueue(await bridge<Queue>(port, "requests"));
    } catch (error) {
      setError(message(error));
    } finally {
      setPending(false);
    }
  }

  const tickets = queue ? [...(queue.active ? [queue.active] : []), ...queue.queued] : [];
  if (tickets.length === 0 && !error) return null;
  return (
    <section
      aria-label="Gemini request queue"
      className="mx-3 mb-1 grid gap-1 rounded-lg border border-border/60 px-3 py-2 text-xs"
    >
      {tickets.map((ticket) => (
        <div key={ticket.id} className="flex flex-wrap items-center gap-2">
          <span>
            {session && session === ticket.session_affinity
              ? "This thread"
              : "Request " + (ticket.session_affinity ?? ticket.id).slice(-8)}
          </span>
          <span className="text-muted-foreground">
            {ticket.model ? `${label(ticket.model)} · ` : ""}
            {stages[ticket.stage] ?? ticket.stage}
            {ticket.position != null ? ` #${ticket.position}` : ""}
            {` · ${Math.max(0, Math.floor(Date.now() / 1000 - ticket.created_at))}s`}
          </span>
          {ticket.status === "queued" ? (
            <>
              <Button
                size="xs"
                variant="ghost"
                disabled={pending || ticket.position === 1}
                onClick={() => void act(ticket.id, "move-ahead")}
              >
                Move to front
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={pending}
                onClick={() => void act(ticket.id, "cancel")}
              >
                Cancel
              </Button>
            </>
          ) : ticket.tabId ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={pending}
              onClick={() => void act(ticket.id, "open-worker")}
            >
              Open worker
            </Button>
          ) : null}
        </div>
      ))}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
