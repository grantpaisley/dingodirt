import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useOwners, createOwner } from '../api/hooks'

/** Owner select with an inline "Add new owner…" create form — shared by the
 *  Import dialog and the track detail pane so the two stay in sync. The
 *  create form mirrors the owners API rules: sources are name-only, people
 *  (kind=friend) need an email. */
export function OwnerPicker({ value, onChange, disabled, placeholder, className }: {
    /** Selected owner id; '' = nothing chosen */
    value: string
    onChange: (ownerId: string) => void
    disabled?: boolean
    /** Label for the empty option (e.g. "Choose owner…") */
    placeholder?: string
    /** Class for the <select> — 'export-input' in dialogs, 'mode-select' in the detail pane */
    className?: string
}) {
    const queryClient = useQueryClient()
    const { data: owners } = useOwners()
    const [creating, setCreating] = useState(false)
    const [newKind, setNewKind] = useState<'friend' | 'source'>('source')
    const [newName, setNewName] = useState('')
    const [newEmail, setNewEmail] = useState('')
    const [error, setError] = useState<string | null>(null)

    const handleCreate = async () => {
        if (!newName.trim()) { setError('Name is required'); return }
        if (newKind === 'friend' && !newEmail.trim()) { setError('Email is required for people'); return }
        try {
            const owner = await createOwner({
                kind: newKind,
                name: newName.trim(),
                email: newEmail.trim() || undefined,
            })
            queryClient.invalidateQueries({ queryKey: ['owners'] })
            setCreating(false)
            setNewName('')
            setNewEmail('')
            setError(null)
            onChange(owner.id)
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        }
    }

    if (creating) {
        return (
            <div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <label className="export-check" style={{ flex: 1 }}>
                        <input type="radio" checked={newKind === 'source'} onChange={() => setNewKind('source')} />
                        Data source
                    </label>
                    <label className="export-check" style={{ flex: 1 }}>
                        <input type="radio" checked={newKind === 'friend'} onChange={() => setNewKind('friend')} />
                        Person
                    </label>
                </div>
                <input
                    className="export-input"
                    placeholder={newKind === 'source' ? 'Source name (e.g., Trailforks AU)' : 'Name'}
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                />
                {newKind === 'friend' && (
                    <input
                        className="export-input"
                        placeholder="Email"
                        type="email"
                        value={newEmail}
                        onChange={e => setNewEmail(e.target.value)}
                    />
                )}
                {error && <div className="export-error">{error}</div>}
                <div style={{ display: 'flex', gap: 8 }}>
                    <button className="export-btn primary" onClick={handleCreate} style={{ flex: 1 }}>Create</button>
                    <button
                        className="export-btn"
                        onClick={() => { setCreating(false); setError(null) }}
                        style={{ flex: 1 }}
                    >
                        Cancel
                    </button>
                </div>
            </div>
        )
    }

    return (
        <select
            className={className ?? 'export-input'}
            value={value}
            disabled={disabled}
            onChange={e => {
                if (e.target.value === '__new__') setCreating(true)
                else onChange(e.target.value)
            }}
            style={{ paddingRight: 28 }}
        >
            <option value="" disabled={!placeholder}>{placeholder ?? 'Choose owner…'}</option>
            {(owners ?? []).map(o => (
                <option key={o.id} value={o.id}>
                    {o.name}{o.kind === 'friend' && o.email ? ` (${o.email})` : ''}
                </option>
            ))}
            <option value="__new__">＋ Add new owner…</option>
        </select>
    )
}
