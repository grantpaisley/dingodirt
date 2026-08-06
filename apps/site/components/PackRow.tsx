"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

interface PackInfo {
  id: string;
  name: string;
  type: string;
  visibility: string;
  shareToken: string;
  version: number;
  downloads: number;
  folder: string | null;
  updatedAt: string;
}

export default function PackRow({ pack }: { pack: PackInfo }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function setVisibility(visibility: string) {
    setBusy(true);
    await fetch(`/api/packs/id/${pack.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility }),
    });
    setBusy(false);
    router.refresh();
  }

  async function retract() {
    if (!confirm(`Retract "${pack.name}"? Its share link will stop working.`))
      return;
    setBusy(true);
    await fetch(`/api/packs/id/${pack.id}`, { method: "DELETE" });
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-line bg-ink-2/80 px-5 py-4">
      <div className="min-w-0 flex-1">
        <Link
          href={`/p/${pack.shareToken}`}
          className="font-display text-xl font-bold uppercase hover:text-clay-hot"
        >
          {pack.name}
        </Link>
        <p className="text-xs text-bone-dim">
          {pack.type} · v{pack.version} · {pack.updatedAt}
          {pack.folder ? ` · 📁 ${pack.folder}` : ""} ·{" "}
          <span className="text-gum">{pack.downloads} downloads</span>
        </p>
      </div>

      <select
        value={pack.visibility === "pending" ? "public" : pack.visibility}
        disabled={busy}
        onChange={(e) => setVisibility(e.target.value)}
        className="rounded border border-line bg-ink-3 px-2 py-1.5 text-sm"
      >
        <option value="private">Private</option>
        <option value="unlisted">Link only</option>
        <option value="public">Public</option>
      </select>
      {pack.visibility === "pending" && (
        <span
          className="rounded-full border border-gum/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gum"
          title="Link works now; it appears in the galleries once reviewed"
        >
          pending review
        </span>
      )}

      <button
        type="button"
        disabled={pack.visibility === "private"}
        onClick={async () => {
          await navigator.clipboard.writeText(
            `${location.origin}/p/${pack.shareToken}`,
          );
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        className="rounded border border-line px-3 py-1.5 text-sm transition-colors hover:border-clay hover:text-clay-hot disabled:opacity-40"
        title={
          pack.visibility === "private"
            ? "Make it 'Link only' or 'Public' first"
            : "Copy share link"
        }
      >
        {copied ? "Copied!" : "Copy link"}
      </button>

      <button
        type="button"
        disabled={busy}
        onClick={retract}
        className="rounded border border-line px-3 py-1.5 text-sm text-bone-dim transition-colors hover:border-clay-hot hover:text-clay-hot"
      >
        Retract
      </button>
    </div>
  );
}
