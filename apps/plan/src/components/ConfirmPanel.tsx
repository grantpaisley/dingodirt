import { useEffect, useRef } from 'react'

interface ConfirmPanelProps {
    /** The question, in one line: "Delete 12 tracks and their files?" */
    question: string
    /** What else goes, or breaks — the reason a two-step confirm exists at
     *  all. Blank lines are dropped, so callers can pass conditional text. */
    detail?: (string | false | null | undefined)[]
    /** Label for the button that commits, e.g. "Delete 12" */
    confirmLabel: string
    busy?: boolean
    onConfirm: () => void
    onCancel: () => void
}

/** The second step of a destructive action, shown inline rather than as a
 *  modal: a browser `confirm()` cannot state what else the action takes, and
 *  every delete here is permanent.
 *
 *  Escape cancels, and the commit button takes focus on open, so Enter
 *  commits the action the user already asked for. */
export function ConfirmPanel({
    question, detail, confirmLabel, busy, onConfirm, onCancel,
}: ConfirmPanelProps) {
    const confirmRef = useRef<HTMLButtonElement>(null)

    useEffect(() => { confirmRef.current?.focus() }, [])

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return
            // Capture phase, and stop there: App's Escape clears the whole
            // selection, which must not happen just for backing out of a
            // confirm (the same guard MapView uses while drawing).
            e.stopPropagation()
            onCancel()
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
    }, [onCancel])

    const lines = (detail ?? []).filter(Boolean) as string[]

    return (
        <div
            role="alertdialog"
            aria-label={question}
            style={{
                marginTop: 8,
                padding: 10,
                border: '1px solid var(--dd-status-bad)',
                borderRadius: 4,
            }}
        >
            <div style={{ fontSize: 12, lineHeight: 1.5 }}>{question}</div>
            {lines.map(line => (
                <div
                    key={line}
                    style={{
                        marginTop: 4,
                        fontSize: 11,
                        lineHeight: 1.5,
                        color: 'var(--text-secondary)',
                    }}
                >
                    {line}
                </div>
            ))}
            <div style={{ display: 'flex', gap: 6, marginTop: 9 }}>
                <button
                    ref={confirmRef}
                    className="export-btn"
                    disabled={busy}
                    onClick={onConfirm}
                    style={{
                        background: 'var(--dd-status-bad)',
                        borderColor: 'var(--dd-status-bad)',
                        color: 'var(--dd-on-status-bad)',
                    }}
                >
                    {busy ? 'Deleting…' : confirmLabel}
                </button>
                <button className="export-btn" disabled={busy} onClick={onCancel}>
                    Cancel
                </button>
            </div>
        </div>
    )
}
