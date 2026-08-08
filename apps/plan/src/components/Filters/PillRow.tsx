// Filter pill row — the faceted-filter UI at the top of the left panel
// (docs/plans/plan-2026-08-07-list-filter-pills-design.md).
//
// Pills AND together; checked values within one pill OR. A pill's dropdown
// shows only values matching the OTHER active pills, with counts (the
// server computes this — see /api/items/query with `facet`). Hierarchical
// dimensions render an expandable tree checkable at any level; boolean
// pills toggle in place; zero-checked pills are inactive (match all).
import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, X, ChevronRight, ChevronDown } from 'lucide-react'
import {
    useDimensions, useFolders, useLabels, fetchFacet,
    type Dimension, type FacetValue, type PillState, type Folder, type Label,
} from '../../api/hooks'
import { useSettings } from '../../store'

/** Pill label summary: "Start: Maroota +2". */
function pillSummary(
    pill: PillState,
    dims: Dimension[],
    folders: Folder[],
    labels: Label[],
): string {
    const dim = dims.find(d => d.id === pill.dimension)
    const name = dim?.name ?? pill.dimension
    if (dim?.kind === 'boolean') return name
    if (pill.values.length === 0) return `${name}: any`
    const first = pill.values[0]
    let label: string
    if (Array.isArray(first)) {
        label = first[first.length - 1]
    } else if (pill.dimension === 'folder') {
        label = first === 'unfiled' ? 'Unfiled'
            : folders.find(f => f.id === first)?.name ?? String(first)
    } else if (pill.dimension.startsWith('labelset:')) {
        label = labels.find(l => l.id === first)?.name ?? String(first)
    } else if (pill.dimension === 'type') {
        label = { track: 'Tracks', route: 'Routes', pack: 'Packs' }[String(first)] ?? String(first)
    } else {
        label = String(first)
    }
    const more = pill.values.length - 1
    return `${name}: ${label}${more > 0 ? ` +${more}` : ''}`
}

interface TreeNode {
    key: string
    label: string
    /** The value this node contributes to the pill when checked — a path
     *  array for location/touches trees, a plain id string for folders
     *  (the server's folder filter takes ids, not paths). */
    value: string | string[]
    count: number
    children: TreeNode[]
}

/** Fold facet path rows into a tree, summing counts up the levels. Leaf
 *  rows repeated across shallower prefixes aggregate automatically. */
function buildTree(rows: FacetValue[]): TreeNode[] {
    const roots: TreeNode[] = []
    const byKey = new Map<string, TreeNode>()
    // Prefix counts: a 4-level leaf row adds its count to every ancestor;
    // explicit shorter rows (touches LGA rows) carry their own counts.
    const explicit = new Set(rows.map(r => (r.path ?? []).join('')))
    for (const row of rows) {
        const path = row.path ?? []
        for (let depth = 1; depth <= path.length; depth++) {
            const prefix = path.slice(0, depth)
            const key = prefix.join('')
            let node = byKey.get(key)
            if (!node) {
                node = { key, label: prefix[depth - 1], value: prefix, count: 0, children: [] }
                byKey.set(key, node)
                const parent = depth > 1 ? byKey.get(prefix.slice(0, -1).join('')) : null
                if (parent) parent.children.push(node)
                else if (depth === 1) roots.push(node)
            }
            // Sum leaf counts upward, but never double-count a level that the
            // server reported explicitly (touches reports LGA rows AND
            // suburb rows — the LGA row already holds the rolled-up count).
            const isLeafRow = depth === path.length
            if (isLeafRow || !explicit.has(key)) node.count += row.count
        }
    }
    // "Unknown" sorts last within each level; everything else alphabetical.
    const sortNodes = (nodes: TreeNode[]) => {
        nodes.sort((a, b) =>
            (a.label === 'Unknown' ? 1 : 0) - (b.label === 'Unknown' ? 1 : 0)
            || a.label.localeCompare(b.label))
        nodes.forEach(n => sortNodes(n.children))
    }
    sortNodes(roots)
    return roots
}

/** Folder tree with rolled-up counts from the folder facet. */
function buildFolderTree(folders: Folder[], counts: Map<string, number>): TreeNode[] {
    const nodes = new Map<string, TreeNode>()
    for (const f of folders) {
        nodes.set(f.id, { key: f.id, label: f.name, value: f.id, count: counts.get(f.id) ?? 0, children: [] })
    }
    const roots: TreeNode[] = []
    for (const f of folders) {
        const node = nodes.get(f.id)!
        const parent = f.parent_id ? nodes.get(f.parent_id) : null
        if (parent) parent.children.push(node)
        else roots.push(node)
    }
    // Subtree rollup: checking a folder matches everything beneath it, so
    // its displayed count should agree.
    const rollup = (n: TreeNode): number => {
        n.count += n.children.reduce((sum, c) => sum + rollup(c), 0)
        return n.count
    }
    roots.forEach(rollup)
    roots.unshift({
        key: 'unfiled', label: 'Unfiled', value: 'unfiled',
        count: counts.get('unfiled') ?? 0, children: [],
    })
    return roots
}

/** Label tree for one set. Counts stay DIRECT (no subtree rollup): labels
 *  are multi-membership, so summing children would double-count items that
 *  carry both a parent and a child label. */
function buildLabelTree(labels: Label[], setId: string, counts: Map<string, number>): TreeNode[] {
    const inSet = labels.filter(l => l.label_set_id === setId)
    const nodes = new Map<string, TreeNode>()
    for (const l of inSet) {
        nodes.set(l.id, { key: l.id, label: l.name, value: l.id, count: counts.get(l.id) ?? 0, children: [] })
    }
    const roots: TreeNode[] = []
    for (const l of inSet) {
        const node = nodes.get(l.id)!
        const parent = l.parent_id ? nodes.get(l.parent_id) : null
        if (parent) parent.children.push(node)
        else roots.push(node)
    }
    return roots
}

const valueKey = (v: string | string[] | boolean): string =>
    Array.isArray(v) ? v.join('') : String(v)

interface DropdownProps {
    pill: PillState
    dim: Dimension
    onChange: (values: PillState['values']) => void
    onClose: () => void
    /** All pills + search — the server ignores same-dimension pills itself */
    pills: PillState[]
    search: string[]
}

function PillDropdown({ pill, dim, onChange, onClose, pills, search }: DropdownProps) {
    const [facet, setFacet] = useState<FacetValue[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [open, setOpen] = useState<Set<string>>(new Set())
    const { data: folders } = useFolders()
    const { data: labelsData } = useLabels()
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        let cancelled = false
        fetchFacet(dim.id, pills, search)
            .then(v => { if (!cancelled) setFacet(v) })
            .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
        return () => { cancelled = true }
        // Refetch when the surrounding pill state changes — that is the
        // faceting contract (counts narrow by the other pills).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dim.id, JSON.stringify(pills.filter(p => p.dimension !== dim.id)), JSON.stringify(search)])

    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose()
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
    }, [onClose])

    const checked = useMemo(() => new Set(pill.values.map(valueKey)), [pill.values])
    const toggle = (value: string | string[]) => {
        const key = valueKey(value)
        onChange(checked.has(key)
            ? pill.values.filter(v => valueKey(v) !== key)
            : [...pill.values, value])
    }

    const tree = useMemo(() => {
        if (!facet) return null
        if (dim.id === 'folder') {
            const counts = new Map(facet.map(v => [String(v.value), v.count]))
            return buildFolderTree(folders ?? [], counts)
        }
        if (dim.id.startsWith('labelset:')) {
            const counts = new Map(facet.map(v => [String(v.value), v.count]))
            return buildLabelTree(labelsData?.labels ?? [], dim.id.slice('labelset:'.length), counts)
        }
        if (dim.kind === 'hierarchical') return buildTree(facet)
        return null
    }, [facet, dim, folders, labelsData])

    const renderNode = (node: TreeNode, depth: number) => {
        const expandable = node.children.length > 0
        const isOpen = open.has(node.key)
        return (
            <div key={node.key}>
                <div className="pill-dropdown-row" style={{ paddingLeft: 6 + depth * 14 }}>
                    <button
                        className="pill-tree-chevron"
                        style={{ visibility: expandable ? 'visible' : 'hidden' }}
                        onClick={() => setOpen(o => {
                            const next = new Set(o)
                            if (next.has(node.key)) next.delete(node.key); else next.add(node.key)
                            return next
                        })}
                    >
                        {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                    <label title={`${node.label} — ${node.count} matching item${node.count === 1 ? '' : 's'}`}>
                        <input
                            type="checkbox"
                            checked={checked.has(node.key)}
                            onChange={() => toggle(node.value)}
                        />
                        <span className="pill-value-label">{node.label}</span>
                        <span className="pill-value-count">{node.count}</span>
                    </label>
                </div>
                {isOpen && node.children.map(c => renderNode(c, depth + 1))}
            </div>
        )
    }

    return (
        <div className="pill-dropdown" ref={ref}>
            {error && <div className="pill-dropdown-error">{error}</div>}
            {!facet && !error && <div className="pill-dropdown-loading">Loading…</div>}
            {tree && tree.map(n => renderNode(n, 0))}
            {facet && !tree && facet.map(v => (
                <div className="pill-dropdown-row" key={String(v.value)}>
                    <label title={`${v.count} matching item${v.count === 1 ? '' : 's'}`}>
                        <input
                            type="checkbox"
                            checked={checked.has(String(v.value))}
                            onChange={() => toggle(String(v.value))}
                        />
                        <span className="pill-value-label">{v.label ?? String(v.value)}</span>
                        <span className="pill-value-count">{v.count}</span>
                    </label>
                </div>
            ))}
        </div>
    )
}

/** The pill row: one chip per pill + committed search pills + the "+" menu. */
export function PillRow() {
    const { pills, addPill, setPillValues, removePill, searchPills, removeSearchPill } = useSettings()
    const { data: dims } = useDimensions()
    const { data: folders } = useFolders()
    const { data: labelsData } = useLabels()
    const [openPill, setOpenPill] = useState<number | null>(null)
    const [menuOpen, setMenuOpen] = useState(false)
    const menuRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!menuOpen) return
        const onDown = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
    }, [menuOpen])

    const search = searchPills
    const available = (dims ?? []).filter(d => !pills.some(p => p.dimension === d.id))

    return (
        <div className="pill-row">
            {pills.map((pill, i) => {
                const dim = (dims ?? []).find(d => d.id === pill.dimension)
                const boolean = dim?.kind === 'boolean'
                const active = pill.values.length > 0
                return (
                    <span key={`${pill.dimension}-${i}`} className={`pill ${active ? 'active' : ''}`}>
                        <button
                            className="pill-label"
                            title={boolean
                                ? `${dim?.name} — click to toggle`
                                : 'Click to edit this filter'}
                            onClick={() => {
                                if (boolean) {
                                    setPillValues(i, active ? [] : [true])
                                } else {
                                    setOpenPill(openPill === i ? null : i)
                                }
                            }}
                        >
                            {pillSummary(pill, dims ?? [], folders ?? [], labelsData?.labels ?? [])}
                        </button>
                        <button
                            className="pill-remove"
                            title="Remove this filter"
                            onClick={() => { setOpenPill(null); removePill(i) }}
                        >
                            <X size={11} />
                        </button>
                        {openPill === i && dim && !boolean && (
                            <PillDropdown
                                pill={pill}
                                dim={dim}
                                pills={pills}
                                search={search}
                                onChange={values => setPillValues(i, values)}
                                onClose={() => setOpenPill(null)}
                            />
                        )}
                    </span>
                )
            })}
            {searchPills.map((q, i) => (
                <span key={`search-${i}`} className="pill active">
                    <span className="pill-label" title="Search filter — ANDs with the other pills">
                        Search: {q}
                    </span>
                    <button
                        className="pill-remove"
                        title="Remove this search"
                        onClick={() => removeSearchPill(i)}
                    >
                        <X size={11} />
                    </button>
                </span>
            ))}
            <span className="pill-add" ref={menuRef}>
                <button
                    className="pill-add-button"
                    title="Add a filter"
                    onClick={() => setMenuOpen(!menuOpen)}
                >
                    <Plus size={12} />
                </button>
                {menuOpen && (
                    <div className="pill-menu">
                        {available.map(d => (
                            <button
                                key={d.id}
                                className="pill-menu-item"
                                onClick={() => {
                                    addPill(d.id)
                                    setMenuOpen(false)
                                    // Boolean pills activate immediately; the
                                    // others open their dropdown to pick values.
                                    if (d.kind === 'boolean') {
                                        setPillValues(pills.length, [true])
                                    } else {
                                        setOpenPill(pills.length)
                                    }
                                }}
                            >
                                {d.name}
                            </button>
                        ))}
                        {available.length === 0 && (
                            <div className="pill-menu-empty">Every filter is in use</div>
                        )}
                    </div>
                )}
            </span>
        </div>
    )
}
