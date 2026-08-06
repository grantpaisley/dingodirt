// Decorative contour-line backdrop + one dashed "route" crossing the hero.
// Pure SVG, aria-hidden, sits behind everything.
export default function TopoBackdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <svg
        className="absolute -top-24 left-1/2 h-[1200px] w-[1600px] -translate-x-1/2 opacity-[0.5]"
        viewBox="0 0 1600 1200"
        fill="none"
      >
        {/* contour rings */}
        <g stroke="var(--line)" strokeWidth="1.2">
          <path d="M300 200c140-90 380-70 460 30s-20 190-180 210-360 10-420-90 20-90 140-150Z" />
          <path d="M270 230c120-80 330-60 400 25s-15 160-155 178-310 8-362-77 15-76 117-126Z" />
          <path d="M240 260c100-66 280-50 340 20s-12 132-130 148-262 6-306-64 12-62 96-104Z" />
          <path d="M1150 700c180-110 470-80 560 50s-30 230-230 250-440 15-510-115 30-110 180-185Z" />
          <path d="M1110 740c150-92 400-68 476 42s-25 194-195 211-374 12-433-97 25-92 152-156Z" />
          <path d="M1070 780c122-75 330-55 392 34s-20 158-160 172-306 10-354-79 20-75 122-127Z" />
          <path d="M1030 820c95-58 260-43 308 26s-16 124-125 135-240 8-278-62 15-59 95-99Z" />
          <path d="M550 950c90-56 240-44 290 22s-14 118-118 130-228 8-264-58 14-56 92-94Z" />
          <path d="M520 980c70-44 190-35 230 17s-11 93-93 102-180 7-208-45 11-44 71-74Z" />
        </g>
        {/* dashed route with waypoints */}
        <path
          className="route-dash"
          d="M-40 640 C 220 560, 340 720, 560 640 S 900 380, 1120 470 S 1460 640, 1680 540"
          stroke="var(--clay)"
          strokeWidth="2.5"
          strokeLinecap="round"
          opacity="0.65"
        />
        <g fill="var(--clay-hot)">
          <circle cx="560" cy="640" r="5" />
          <circle cx="1120" cy="470" r="5" />
        </g>
        <circle
          cx="1120"
          cy="470"
          r="11"
          stroke="var(--clay-hot)"
          strokeWidth="1.5"
          fill="none"
          opacity="0.6"
        />
      </svg>
      {/* soft vignette so text always sits on quiet ground */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,var(--ink)_78%)]" />
    </div>
  );
}
