-- Named export destinations for the selection→export pipeline: a local folder
-- (typically synced to a device by Syncthing/cloud sync) plus the nav-app
-- profile and layout to write bundles with. Managed via /api/destinations and
-- shared with the CLI (`dingo export bundle --dest-name …`).
CREATE TABLE export_destinations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    -- osmand | locus | dmd2 | generic (validated in code)
    profile TEXT NOT NULL DEFAULT 'generic',
    -- flat | tree (validated in code)
    layout TEXT NOT NULL DEFAULT 'flat',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
