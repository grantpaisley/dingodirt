"use client";

import { useState } from "react";

export default function CopyLinkButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(`${location.origin}${path}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="rounded border border-line px-6 py-3.5 font-display text-xl font-bold uppercase tracking-wide transition-colors hover:border-clay hover:text-clay-hot"
    >
      {copied ? "Copied!" : "Copy link"}
    </button>
  );
}
