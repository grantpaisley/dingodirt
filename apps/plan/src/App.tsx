import { useState, useCallback, useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Bounds } from './api/hooks'
import { MapView } from './components/Map/MapView'
import { ListPane } from './components/List/ListPane'
import { DetailPane } from './components/Detail/DetailPane'
import { PackDetail } from './components/Detail/PackDetail'
import { useUiState } from './store'
import { GraphPane, type CursorInfo } from './components/Graph/GraphPane'
import { ExportDialog } from './components/Export/ExportDialog'
import { ResizeHandle } from './components/ResizeHandle'
import { StatsBar } from './components/StatsBar'
import { useRideSchemeMount } from './scheme/useRideScheme'
import './App.css'

const queryClient = new QueryClient()

const MIN_PANE_WIDTH = 200
const MAX_PANE_WIDTH = 500
const DEFAULT_PANE_WIDTH = 320

const MIN_GRAPH_HEIGHT = 100
const MAX_GRAPH_HEIGHT = 400
const DEFAULT_GRAPH_HEIGHT = 200

function App() {
  useRideSchemeMount() // active .dingoscheme re-mounts its CSS variables
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [leftPaneOpen, setLeftPaneOpen] = useState(true)
  const [rightPaneOpen, setRightPaneOpen] = useState(true)
  const [leftPaneWidth, setLeftPaneWidth] = useState(DEFAULT_PANE_WIDTH)
  const [rightPaneWidth, setRightPaneWidth] = useState(DEFAULT_PANE_WIDTH)
  const [graphOpen, setGraphOpen] = useState(true)
  const [graphHeight, setGraphHeight] = useState(DEFAULT_GRAPH_HEIGHT)
  const [mapBounds, setMapBounds] = useState<Bounds | undefined>()
  // Export dialog: {} exports the basket; rideIds/name preload it from a pack.
  const [exportReq, setExportReq] = useState<{ rideIds?: string[], name?: string } | null>(null)
  // Packs view: the selected pack's contents replace the ride detail pane.
  const { listView, selectedPackId } = useUiState()
  // Profile↔map sync: the graph cursor's track position (dot on the map), and
  // the map hover position on a selected track (cursor line on the graph)
  const [graphCursor, setGraphCursor] = useState<CursorInfo | null>(null)
  const [mapCursor, setMapCursor] = useState<{ rideId: string, lon: number, lat: number } | null>(null)
  // Places view: clicking a folder flies the map to its bounding box (nonce
  // so re-clicking the same folder flies again)
  const [flyTo, setFlyTo] = useState<{ bbox: [number, number, number, number], nonce: number } | null>(null)
  const handleFlyTo = useCallback((bbox: [number, number, number, number]) => {
    setFlyTo(prev => ({ bbox, nonce: (prev?.nonce ?? 0) + 1 }))
  }, [])

  const handleLeftResize = useCallback((delta: number) => {
    setLeftPaneWidth(w => Math.min(MAX_PANE_WIDTH, Math.max(MIN_PANE_WIDTH, w + delta)))
  }, [])

  const handleRightResize = useCallback((delta: number) => {
    setRightPaneWidth(w => Math.min(MAX_PANE_WIDTH, Math.max(MIN_PANE_WIDTH, w + delta)))
  }, [])

  const handleGraphResize = useCallback((delta: number) => {
    setGraphHeight(h => Math.min(MAX_GRAPH_HEIGHT, Math.max(MIN_GRAPH_HEIGHT, h + delta)))
  }, [])

  // Escape clears the current selection (unless typing in an input)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      setSelectedIds([])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <div className="app">
        {/* Left Pane - List */}
        <aside
          className={`left-pane ${leftPaneOpen ? 'open' : 'collapsed'}`}
          style={leftPaneOpen ? { width: leftPaneWidth } : undefined}
        >
          <button
            className="pane-toggle left"
            onClick={() => setLeftPaneOpen(!leftPaneOpen)}
          >
            {leftPaneOpen ? '◀' : '▶'}
          </button>
          {leftPaneOpen && (
            <ListPane
              selectedIds={selectedIds}
              onSelect={setSelectedIds}
              onHover={setHoveredId}
              bounds={mapBounds}
              onExport={() => setExportReq({})}
              onFlyTo={handleFlyTo}
            />
          )}
        </aside>

        {/* Left Resize Handle */}
        {leftPaneOpen && <ResizeHandle position="left" onResize={handleLeftResize} />}

        {/* Center - Map + Graph */}
        <main className="map-container">
          <StatsBar selectedIds={selectedIds} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
            <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
                <MapView
                  selectedIds={selectedIds}
                  hoveredId={hoveredId}
                  onSelect={setSelectedIds}
                  onHover={setHoveredId}
                  onBoundsChange={setMapBounds}
                  graphCursor={graphCursor}
                  onTrackHoverPoint={setMapCursor}
                  flyTo={flyTo}
                />
              </div>
            </div>
            <GraphPane
              selectedIds={selectedIds}
              isOpen={graphOpen}
              onToggle={() => setGraphOpen(!graphOpen)}
              height={graphHeight}
              onResize={handleGraphResize}
              onCursorChange={setGraphCursor}
              mapCursor={mapCursor}
            />
          </div>
        </main>

        {/* Right Resize Handle */}
        {rightPaneOpen && <ResizeHandle position="right" onResize={handleRightResize} />}

        {/* Right Pane - Detail */}
        <aside
          className={`right-pane ${rightPaneOpen ? 'open' : 'collapsed'}`}
          style={rightPaneOpen ? { width: rightPaneWidth } : undefined}
        >
          <button
            className="pane-toggle right"
            onClick={() => setRightPaneOpen(!rightPaneOpen)}
          >
            {rightPaneOpen ? '▶' : '◀'}
          </button>
          {rightPaneOpen && (
            listView === 'packs' && selectedPackId ? (
              <PackDetail
                packId={selectedPackId}
                onSelect={setSelectedIds}
                onFlyTo={handleFlyTo}
                onExport={(rideIds, name) => setExportReq({ rideIds, name })}
              />
            ) : (
              <DetailPane selectedIds={selectedIds} hoveredId={hoveredId} onSelect={setSelectedIds} />
            )
          )}
        </aside>

        {exportReq && (
          <ExportDialog
            onClose={() => setExportReq(null)}
            rideIds={exportReq.rideIds}
            defaultName={exportReq.name}
          />
        )}
      </div>
    </QueryClientProvider>
  )
}

export default App
