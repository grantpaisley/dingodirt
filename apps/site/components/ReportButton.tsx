"use client";

import { useState } from "react";

export default function ReportButton({ token }: { token: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">(
    "idle",
  );

  if (state === "done") {
    return (
      <p className="text-sm text-gum">
        Report sent — thanks for looking out for the trails.
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm text-bone-dim underline transition-colors hover:text-clay-hot"
      >
        Report a problem with this route
      </button>
    );
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setState("sending");
        try {
          const res = await fetch("/api/report", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token, reason }),
          });
          const json = (await res.json()) as { ok: boolean };
          setState(json.ok ? "done" : "error");
        } catch {
          setState("error");
        }
      }}
    >
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        required
        rows={2}
        placeholder="What's wrong? e.g. crosses private property near the creek gate"
        className="w-full rounded border border-line bg-ink-2 px-3 py-2 text-sm text-bone placeholder:text-bone-dim/60 focus:border-clay focus:outline-none"
      />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={state === "sending"}
          className="rounded border border-line px-3 py-1.5 text-sm transition-colors hover:border-clay hover:text-clay-hot disabled:opacity-60"
        >
          {state === "sending" ? "Sending…" : "Send report"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded px-3 py-1.5 text-sm text-bone-dim hover:text-bone"
        >
          Cancel
        </button>
      </div>
      {state === "error" && (
        <p className="text-sm text-clay-hot">
          Couldn&apos;t send — try again in a bit.
        </p>
      )}
    </form>
  );
}
