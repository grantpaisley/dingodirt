"use client";

import { useCallback, useEffect, useState } from "react";

interface PackRow {
  id: string;
  name: string;
  type: string;
  authorName: string;
  visibility: string;
  downloads: number;
  shareToken: string;
  deletedAt: string | null;
}
interface ReportRow {
  id: string;
  packId: string;
  reason: string;
  createdAt: string;
}
interface RoleRow {
  email: string;
  role: string;
}
interface Overview {
  pending: PackRow[];
  reports: ReportRow[];
  roles: RoleRow[];
  packs: PackRow[];
}

export default function AdminPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin");
      const json = await res.json();
      if (json.ok) setData(json);
      else setError("Couldn't load admin data.");
    } catch {
      setError("Couldn't load admin data (is the database configured?).");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(body: Record<string, unknown>) {
    await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    load();
  }

  if (error) return <p className="mt-6 text-clay-hot">{error}</p>;
  if (!data) return <p className="mt-6 text-bone-dim">Loading…</p>;

  const packName = (id: string) =>
    data.packs.find((p) => p.id === id)?.name ?? id;

  const sectionCls = "mt-10";
  const h2Cls =
    "font-display text-sm font-medium uppercase tracking-[0.25em] text-bone-dim";
  const rowCls =
    "flex flex-wrap items-center gap-x-4 gap-y-1 rounded border border-line bg-ink-2/80 px-4 py-3 text-sm";
  const btnCls =
    "rounded border border-line px-2.5 py-1 text-xs transition-colors hover:border-clay hover:text-clay-hot";

  return (
    <div>
      <section className={sectionCls}>
        <h2 className={h2Cls}>
          Review queue — going public ({data.pending.length})
        </h2>
        <div className="mt-4 flex flex-col gap-2">
          {data.pending.length === 0 && (
            <p className="text-sm text-bone-dim">Nothing waiting for review.</p>
          )}
          {data.pending.map((p) => (
            <div key={p.id} className={rowCls}>
              <span className="flex-1">
                <a
                  href={`/p/${p.shareToken}`}
                  className="font-bold text-bone underline hover:text-clay-hot"
                  target="_blank"
                >
                  {p.name}
                </a>{" "}
                <span className="text-bone-dim">
                  · {p.type} · {p.authorName}
                </span>
              </span>
              <button
                className={btnCls}
                onClick={() => act({ action: "approve-pack", packId: p.id })}
              >
                Approve
              </button>
              <button
                className={btnCls}
                onClick={() => act({ action: "reject-pack", packId: p.id })}
              >
                Reject → unlisted
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className={sectionCls}>
        <h2 className={h2Cls}>Open reports ({data.reports.length})</h2>
        <div className="mt-4 flex flex-col gap-2">
          {data.reports.length === 0 && (
            <p className="text-sm text-bone-dim">No open reports.</p>
          )}
          {data.reports.map((r) => (
            <div key={r.id} className={rowCls}>
              <span className="flex-1">
                <strong className="text-bone">{packName(r.packId)}</strong>{" "}
                <span className="text-bone-dim">— “{r.reason}”</span>
              </span>
              <button
                className={btnCls}
                onClick={() => {
                  if (confirm("Hide this pack? Its link will die."))
                    act({ action: "hide-pack", packId: r.packId });
                }}
              >
                Hide pack
              </button>
              <button
                className={btnCls}
                onClick={() => act({ action: "resolve-report", reportId: r.id })}
              >
                Resolve
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className={sectionCls}>
        <h2 className={h2Cls}>Trusted &amp; admins ({data.roles.length})</h2>
        <div className="mt-4 flex flex-col gap-2">
          {data.roles.map((m) => (
            <div key={m.email} className={rowCls}>
              <span className="flex-1">
                <strong className="text-bone">{m.email}</strong>{" "}
                <span className="text-gum">{m.role}</span>
              </span>
              <button
                className={btnCls}
                onClick={() => act({ action: "remove-role", email: m.email })}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (newEmail) {
              act({ action: "set-role", email: newEmail, role: "trusted" });
              setNewEmail("");
            }
          }}
        >
          <input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="mate@example.com"
            className="flex-1 rounded border border-line bg-ink-2 px-3 py-2 text-sm placeholder:text-bone-dim/60 focus:border-clay focus:outline-none"
          />
          <button type="submit" className={btnCls}>
            Mark trusted
          </button>
        </form>
      </section>

      <section className={sectionCls}>
        <h2 className={h2Cls}>All packs ({data.packs.length})</h2>
        <div className="mt-4 flex flex-col gap-2">
          {data.packs.length === 0 && (
            <p className="text-sm text-bone-dim">No packs yet.</p>
          )}
          {data.packs.map((p) => (
            <div key={p.id} className={rowCls}>
              <span className="flex-1">
                <strong className="text-bone">{p.name}</strong>{" "}
                <span className="text-bone-dim">
                  · {p.type} · {p.authorName} · {p.visibility} · {p.downloads}{" "}
                  dl
                  {p.deletedAt ? " · RETRACTED" : ""}
                </span>
              </span>
              {!p.deletedAt && (
                <button
                  className={btnCls}
                  onClick={() => {
                    if (confirm(`Hide "${p.name}"? Its link will die.`))
                      act({ action: "hide-pack", packId: p.id });
                  }}
                >
                  Hide
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
