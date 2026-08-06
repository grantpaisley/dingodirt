import { PackageMinus, PackagePlus } from 'lucide-react'
import { useRideStats } from '../api/hooks'
import { useBasket } from '../store'

interface StatsBarProps {
    selectedIds: string[]
    visibleRideCount?: number  // Rides visible on map (filtered/viewport)
    totalRideCount?: number    // Total rides in database
}

export function StatsBar({ selectedIds, visibleRideCount, totalRideCount }: StatsBarProps) {
    // Library-wide totals come from a SQL aggregate — not from summing the
    // (capped, geometry-laden) ride list the client happens to hold.
    const { data: stats } = useRideStats()
    const basket = useBasket()
    // Selection→basket actions: how a lasso or multi-select becomes an export
    const notInBasket = selectedIds.filter(id => !basket.ids.includes(id))
    const inBasket = selectedIds.filter(id => basket.ids.includes(id))

    const visible = visibleRideCount ?? stats?.ride_count ?? 0
    const total = totalRideCount ?? stats?.ride_count ?? 0
    const totalDistance = stats?.total_distance_m ?? 0

    const dateRange = stats?.first_date && stats?.last_date
        ? `${formatMonth(stats.first_date)} - ${formatMonth(stats.last_date)}`
        : null

    return (
        <div className="stats-bar">
            <div className="stats-bar-item">
                <span className="stats-bar-value">{visible}</span>
                <span className="stats-bar-label">
                    {total > visible ? ` of ${total}` : ''} rides
                </span>
            </div>

            <div className="stats-bar-divider" />

            <div className="stats-bar-item">
                <span className="stats-bar-value">{formatDistance(totalDistance)}</span>
                <span className="stats-bar-label">total</span>
            </div>

            {dateRange && (
                <>
                    <div className="stats-bar-divider" />
                    <div className="stats-bar-item">
                        <span className="stats-bar-label">{dateRange}</span>
                    </div>
                </>
            )}

            {selectedIds.length > 0 && (
                <>
                    <div className="stats-bar-divider" />
                    <div className="stats-bar-item stats-bar-selection">
                        <span className="stats-bar-value">{selectedIds.length}</span>
                        <span className="stats-bar-label">selected</span>
                    </div>
                    {notInBasket.length > 0 && (
                        <button
                            className="stats-bar-basket-btn"
                            onClick={() => basket.add(notInBasket)}
                            title="Add the selected tracks to the export basket"
                        >
                            <PackagePlus size={12} style={{ verticalAlign: -2, marginRight: 3 }} />
                            Add {notInBasket.length} to basket
                        </button>
                    )}
                    {notInBasket.length === 0 && inBasket.length > 0 && (
                        <button
                            className="stats-bar-basket-btn"
                            onClick={() => basket.remove(inBasket)}
                            title="Remove the selected tracks from the export basket"
                        >
                            <PackageMinus size={12} style={{ verticalAlign: -2, marginRight: 3 }} />
                            Remove {inBasket.length} from basket
                        </button>
                    )}
                </>
            )}
        </div>
    )
}

function formatDistance(meters: number): string {
    if (meters < 1000) return `${Math.round(meters)}m`
    return `${(meters / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })} km`
}

function formatMonth(dateStr: string): string {
    const date = new Date(dateStr)
    return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}
