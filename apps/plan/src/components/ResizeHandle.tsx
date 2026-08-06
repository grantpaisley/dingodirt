import { useCallback, useRef, useEffect } from 'react'

interface ResizeHandleProps {
    onResize: (delta: number) => void
    position: 'left' | 'right'
}

export function ResizeHandle({ onResize, position }: ResizeHandleProps) {
    const isDragging = useRef(false)
    const lastX = useRef(0)

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        isDragging.current = true
        lastX.current = e.clientX
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
    }, [])

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging.current) return

            const delta = e.clientX - lastX.current
            lastX.current = e.clientX

            // For left pane, positive delta = wider
            // For right pane, positive delta = narrower (inverted)
            onResize(position === 'left' ? delta : -delta)
        }

        const handleMouseUp = () => {
            isDragging.current = false
            document.body.style.cursor = ''
            document.body.style.userSelect = ''
        }

        document.addEventListener('mousemove', handleMouseMove)
        document.addEventListener('mouseup', handleMouseUp)

        return () => {
            document.removeEventListener('mousemove', handleMouseMove)
            document.removeEventListener('mouseup', handleMouseUp)
        }
    }, [onResize, position])

    return (
        <div
            className={`resize-handle resize-handle-${position}`}
            onMouseDown={handleMouseDown}
        />
    )
}
