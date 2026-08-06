"use client";

import { useEffect, useState } from "react";

interface TokenRow {
  id: string;
  name: string;
  lastUsedAt: string | null;
  createdAt: string;
}

/**
 * Dashboard card for machine credentials: create a token for Plan/Studio
 * (secret shown exactly once), list live ones with last-used, revoke.
 */
export default function ApiTokensCard() {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [name, setName] = useState("");
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const res = await fetch("/api/tokens");
      const json = (await res.json()) as { ok: boolean; tokens?: TokenRow[] };
      if (json.ok && json.tokens) setTokens(json.tokens);
    } catch {}
  }
  useEffect(() => {
    // State only lands after the fetch resolves — nothing synchronous here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, []);

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        secret?: string;
      };
      if (json.ok && json.secret) {
        setFreshSecret(json.secret);
        setCopied(false);
        setName("");
        refresh();
      } else {
        setError(json.error ?? "Couldn't create the token.");
      }
    } catch {
      setError("Network hiccup — give it another go.");
    }
    setBusy(false);
  }

  async function revoke(id: string) {
    try {
      await fetch(`/api/tokens?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } catch {}
    refresh();
  }

  const fmt = (d: string | null) => (d ? d.slice(0, 10) : "never");

  return (
    <section className="mt-14 rounded-lg border border-line bg-ink-2/60 p-6">
      <h2 className="font-display text-2xl font-bold uppercase">API tokens</h2>
      <p className="mt-1 text-sm text-bone-dim">
        Let Dingo Plan or Studio publish packs from your machine. Paste a
        token into the app&apos;s settings — treat it like a password.
      </p>

      {freshSecret && (
        <div className="mt-4 rounded border border-clay/50 bg-ink-3 p-4">
          <p className="text-sm font-bold text-clay-hot">
            Copy this now — it won&apos;t be shown again.
          </p>
          <div className="mt-2 flex items-center gap-3">
            <code className="min-w-0 flex-1 overflow-x-auto rounded bg-ink px-3 py-2 text-sm">
              {freshSecret}
            </code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(freshSecret).catch(() => {});
                setCopied(true);
              }}
              className="rounded bg-clay px-4 py-2 font-display font-bold uppercase text-ink transition-colors hover:bg-clay-hot"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
          placeholder="Token name (e.g. Grant's MacBook)"
          className="min-w-0 flex-1 rounded border border-line bg-ink px-3 py-2 text-sm placeholder:text-bone-dim/60"
        />
        <button
          type="button"
          onClick={create}
          disabled={busy || !name.trim()}
          className="rounded bg-clay px-5 py-2 font-display font-bold uppercase text-ink transition-colors hover:bg-clay-hot disabled:opacity-40"
        >
          Create
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-clay-hot">{error}</p>}

      {tokens.length > 0 && (
        <ul className="mt-5 flex flex-col divide-y divide-line/60">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center gap-4 py-2.5 text-sm">
              <span className="min-w-0 flex-1 truncate font-bold">
                {t.name}
              </span>
              <span className="text-bone-dim">
                created {fmt(t.createdAt)} · last used {fmt(t.lastUsedAt)}
              </span>
              <button
                type="button"
                onClick={() => revoke(t.id)}
                className="rounded border border-line px-3 py-1 uppercase text-bone-dim transition-colors hover:border-clay-hot hover:text-clay-hot"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
