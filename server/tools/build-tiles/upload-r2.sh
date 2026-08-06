#!/usr/bin/env bash
# Upload the archive to Cloudflare R2 via rclone (S3-compatible).
#
# One-time setup:
#   brew install rclone
#   Cloudflare dashboard -> R2 -> Create bucket "dingodirt-tiles"
#     -> Manage API tokens -> create token (Object Read & Write, this bucket)
#   rclone config create r2 s3 provider=Cloudflare \
#     access_key_id=<key> secret_access_key=<secret> \
#     endpoint=https://<account_id>.r2.cloudflarestorage.com
#
# Then:
#   ./upload-r2.sh                 # uploads basemap, hillshade, manifest
#
# After first upload, in the Cloudflare dashboard:
#   1. R2 -> dingodirt-tiles -> Settings -> Custom domains
#      -> add tiles.dingodirt.com (creates the DNS record for you)
#   2. Settings -> CORS policy -> paste cors.json
#      (range requests from nav./studio./plan. need GET + Range)
set -euo pipefail
cd "$(dirname "$0")"

BUCKET="${BUCKET:-dingodirt-tiles}"
REMOTE="${REMOTE:-r2}"

for f in basemap-au.pmtiles hillshade-au.pmtiles manifest.json; do
  [[ -f "$f" ]] || { echo "missing $f — build it first"; exit 1; }
done

rclone copy --progress --s3-chunk-size 64M basemap-au.pmtiles "$REMOTE:$BUCKET/"
rclone copy --progress --s3-chunk-size 64M hillshade-au.pmtiles "$REMOTE:$BUCKET/"
rclone copy manifest.json "$REMOTE:$BUCKET/"

echo "uploaded. verify:"
echo "  curl -sI https://tiles.dingodirt.com/manifest.json"
echo "  curl -s -H 'Range: bytes=0-127' -o /dev/null -w '%{http_code}\n' https://tiles.dingodirt.com/basemap-au.pmtiles   # expect 206"
