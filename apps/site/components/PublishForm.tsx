"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export default function PublishForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    const data = new FormData();
    data.append("file", file);
    try {
      const res = await fetch("/api/packs", { method: "POST", body: data });
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        pack?: { shareToken: string };
      };
      if (json.ok && json.pack) {
        router.push(`/p/${json.pack.shareToken}`);
      } else {
        setError(json.error ?? "Publish failed — try again.");
        setBusy(false);
      }
    } catch {
      setError("Network hiccup — give it another go.");
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files[0];
          if (file) upload(file);
        }}
        disabled={busy}
        className={`w-full rounded-lg border-2 border-dashed px-6 py-14 text-center transition-colors ${
          dragOver
            ? "border-clay bg-ink-3"
            : "border-line bg-ink-2 hover:border-clay/60"
        }`}
      >
        <p className="font-display text-2xl font-bold uppercase">
          {busy ? "Uploading…" : "Drop your pack here"}
        </p>
        <p className="mt-1.5 text-sm text-bone-dim">
          or click to choose a file (.dingonav / .dingoscheme, max 50 MB)
        </p>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".dingonav,.dingoscheme"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) upload(file);
        }}
      />
      {error && <p className="mt-3 text-sm text-clay-hot">{error}</p>}
    </div>
  );
}
