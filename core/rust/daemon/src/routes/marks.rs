//! Pack mark edits: typed ride cues flowing back from DingoNav.
//!
//! DingoNav riders add/remove marks on the trail; every edit publishes to the
//! pack's ntfy.sh ride topic (and sits in each rider's outbox, re-announced on
//! app open). We harvest that topic on demand, queue the edits for per-item
//! review, and the publish path bakes accepted ones into the bundle as the
//! `turnEdits` array DingoNav already replays on load.
//! Design: Docs/plans/2026-07-18-marks-sync-design.md

use axum::http::StatusCode;
use axum::{
    Json, Router,
    extract::{Extension, Path as AxumPath},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::export::{ApiError, bad_request, internal};

pub fn routes() -> Router {
    Router::new()
        .route("/{id}/marks", get(list_marks))
        .route("/{id}/marks/check", post(check_marks))
        .route("/{id}/marks/paste", post(paste_marks))
        .route("/{id}/marks/{mark_id}", post(set_mark_status))
}

/// A mark edit in DingoNav's wire shape — the same record travels the live
/// ntfy channel, the clipboard blob, and the baked bundle. `kind` missing =
/// `turn` (pre-marks records); `dir` is turn-only.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkEdit {
    #[serde(default)]
    pub id: Option<String>,
    pub op: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    pub la: f64,
    pub lo: f64,
    pub t: i64,
    #[serde(default)]
    pub by: Option<String>,
}

/// DingoNav's `turnEditId` hash, replicated bit-for-bit so id-less records
/// (hand-edited paste blobs) dedupe identically on both sides:
/// `hash36(op + '|' + la + '|' + lo + '|' + t)` with h = (h*31 + c) >>> 0.
/// JS stringifies the numbers with shortest-round-trip formatting, which is
/// exactly what Rust's `{}` on f64 emits.
fn dn_hash_id(op: &str, la: f64, lo: f64, t: i64) -> String {
    let s = format!("{op}|{la}|{lo}|{t}");
    let mut h: u32 = 0;
    for c in s.chars() {
        h = h.wrapping_mul(31).wrapping_add(c as u32);
    }
    to_base36(h)
}

fn to_base36(mut n: u32) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("base36 digits are ascii")
}

/// The nine picker kinds (design doc). Storage deliberately accepts any
/// lowercase token so a newer DingoNav's kinds survive a round-trip.
#[cfg(test)]
const KINDS: [&str; 9] = [
    "turn", "danger", "obstacle", "gate", "creek", "fuel", "food", "lookout", "camp",
];

/// Validate one incoming record into storable form. `None` = skip silently
/// (the topic is world-writable, so junk must not break a harvest): bad op,
/// `spot` (live-channel-only social feature), or out-of-range coordinates.
fn sanitize_edit(mut e: MarkEdit) -> Option<MarkEdit> {
    if e.op != "add" && e.op != "remove" {
        return None;
    }
    if !(-90.0..=90.0).contains(&e.la) || !(-180.0..=180.0).contains(&e.lo) {
        return None;
    }
    // Unknown kinds (a newer DingoNav) are kept verbatim if they look like a
    // kind; anything weird collapses to turn rather than being dropped.
    let kind = e.kind.take().unwrap_or_else(|| "turn".into());
    let kind_ok = kind.len() <= 16 && kind.chars().all(|c| c.is_ascii_lowercase() || c == '-');
    e.kind = Some(if kind_ok && !kind.is_empty() { kind } else { "turn".into() });
    e.dir = e.dir.take().filter(|d| matches!(d.as_str(), "L" | "R" | "S"));
    e.by = Some(
        e.by.take()
            .map(|b| b.chars().take(40).collect::<String>())
            .filter(|b| !b.trim().is_empty())
            .unwrap_or_else(|| "rider".into()),
    );
    if e.id.as_deref().map_or(true, str::is_empty) {
        e.id = Some(dn_hash_id(&e.op, e.la, e.lo, e.t));
    }
    Some(e)
}

/// Insert edits, ignoring ones already seen (same id) — re-polling the topic
/// or pasting the same blob twice is a no-op, mirroring DingoNav's seen-set.
/// Returns how many were genuinely new.
pub(crate) async fn upsert_marks(
    pool: &PgPool,
    pack_id: Uuid,
    edits: impl IntoIterator<Item = MarkEdit>,
) -> Result<i64, ApiError> {
    let mut new = 0i64;
    for e in edits {
        let Some(e) = sanitize_edit(e) else { continue };
        let res = sqlx::query(
            r#"
            INSERT INTO pack_mark_edits (id, pack_id, op, kind, dir, lat, lon, edited_at, edited_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0), $9)
            ON CONFLICT (pack_id, id) DO NOTHING
            "#,
        )
        .bind(e.id.as_deref().expect("sanitize_edit fills id"))
        .bind(pack_id)
        .bind(&e.op)
        .bind(e.kind.as_deref().expect("sanitize_edit fills kind"))
        .bind(&e.dir)
        .bind(e.la)
        .bind(e.lo)
        .bind(e.t as f64)
        .bind(e.by.as_deref().expect("sanitize_edit fills by"))
        .execute(pool)
        .await
        .map_err(internal)?;
        new += res.rows_affected() as i64;
    }
    Ok(new)
}

/// The ntfy topic for a pack's baked ride name — DingoNav's `friendTopic()`
/// sanitisation, so both ends land on the same channel.
pub fn mark_topic(ride_name: &str) -> String {
    let code: String = ride_name
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_' || *c == '-')
        .collect();
    format!("dingonav-{code}")
}

/// The frozen group-ride channel name, minted at first publish: the pack name
/// with non-alphanumerics stripped + the publish year ("Dunns Swamp" in 2026
/// → "DunnsSwamp2026"). A pack already named with the year ("Kandos_2026")
/// keeps it single — "Kandos2026", not "Kandos20262026".
pub fn mint_ride_name(pack_name: &str, year: i32) -> String {
    let base: String = pack_name.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let base = if base.is_empty() { "pack".to_string() } else { base };
    let year = year.to_string();
    if base.ends_with(&year) { base } else { format!("{base}{year}") }
}

async fn pack_ride_name(pool: &PgPool, id: Uuid) -> Result<Option<String>, ApiError> {
    let row = sqlx::query("SELECT ride_name FROM packs WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(internal)?
        .ok_or((StatusCode::NOT_FOUND, format!("no pack {id}")))?;
    Ok(row.get("ride_name"))
}

// ---- Harvest ----

/// Pull the topic's cached history (ntfy.sh keeps ~12 h; DingoNav re-announces
/// full outboxes on app open to repopulate it) and queue anything new.
async fn check_marks(
    Extension(pool): Extension<PgPool>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ride_name = pack_ride_name(&pool, id).await?.ok_or(bad_request(
        "pack has no ride channel yet — publish it first",
    ))?;
    let edits = poll_ntfy(&mark_topic(&ride_name))
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("ntfy poll failed: {e}")))?;
    let new = upsert_marks(&pool, id, edits).await?;
    let pending = count_pending(&pool, id).await?;
    Ok(Json(serde_json::json!({ "new": new, "pending": pending })))
}

/// Fetch and parse the topic's cached messages. Response is line-delimited
/// JSON events; mark edits are `message` events whose body is a JSON object
/// with `k: "turn"` (the live channel's message kind, shared with pre-marks
/// clients). Anything unparseable is skipped, never fatal.
pub async fn poll_ntfy(topic: &str) -> Result<Vec<MarkEdit>, String> {
    let url = format!("https://ntfy.sh/{topic}/json?poll=1");
    let body = ntfy_http()
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    Ok(parse_ntfy_lines(&body))
}

fn parse_ntfy_lines(body: &str) -> Vec<MarkEdit> {
    body.lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .filter(|ev| ev.get("event").and_then(|e| e.as_str()) == Some("message"))
        .filter_map(|ev| {
            let msg = ev.get("message")?.as_str()?.to_string();
            let v: serde_json::Value = serde_json::from_str(&msg).ok()?;
            if v.get("k").and_then(|k| k.as_str()) != Some("turn") {
                return None;
            }
            serde_json::from_value::<MarkEdit>(v).ok()
        })
        .collect()
}

fn ntfy_http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .user_agent("dingo-daemon")
            .build()
            .expect("build reqwest client")
    })
}

// ---- Paste fallback ----

#[derive(Debug, Deserialize)]
struct PasteBody {
    #[serde(rename = "turnEdits")]
    turn_edits: Vec<MarkEdit>,
}

/// Manual fallback: the blob DingoNav's "Copy mark edits for Dingo" button
/// puts on the clipboard, pasted into the pack UI.
async fn paste_marks(
    Extension(pool): Extension<PgPool>,
    AxumPath(id): AxumPath<Uuid>,
    Json(body): Json<PasteBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Pasting is allowed pre-publish (no topic needed), but the pack must exist.
    pack_ride_name(&pool, id).await?;
    let new = upsert_marks(&pool, id, body.turn_edits).await?;
    let pending = count_pending(&pool, id).await?;
    Ok(Json(serde_json::json!({ "new": new, "pending": pending })))
}

async fn count_pending(pool: &PgPool, id: Uuid) -> Result<i64, ApiError> {
    let row = sqlx::query(
        "SELECT count(*) AS n FROM pack_mark_edits WHERE pack_id = $1 AND status = 'pending'",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .map_err(internal)?;
    Ok(row.get("n"))
}

// ---- Review list ----

/// Pending + accepted edits, each matched to the nearest pack ride track for
/// the review ordering (ride position in the pack, then km along the track —
/// reviewing reads like riding the route). Farther than 250 m from every
/// track = off_track, sorted last. Rejected edits stay hidden.
async fn list_marks(
    Extension(pool): Extension<PgPool>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    pack_ride_name(&pool, id).await?;
    let rows = sqlx::query(
        r#"
        SELECT m.id, m.op, m.kind, m.dir, m.lat, m.lon, m.edited_at, m.edited_by, m.status,
               n.ride_id, n.ride_name, n.km, n.dist_m, n.position
        FROM pack_mark_edits m
        LEFT JOIN LATERAL (
            SELECT r.id AS ride_id, r.name AS ride_name, pr.position,
                   ST_Distance(r.cleaned_geometry::geography,
                               ST_SetSRID(ST_MakePoint(m.lon, m.lat), 4326)::geography) AS dist_m,
                   ST_LineLocatePoint(r.cleaned_geometry,
                                      ST_SetSRID(ST_MakePoint(m.lon, m.lat), 4326))
                       * ST_Length(r.cleaned_geometry::geography) / 1000.0 AS km
            FROM pack_rides pr
            JOIN rides r ON r.id = pr.ride_id
            WHERE pr.pack_id = m.pack_id AND r.cleaned_geometry IS NOT NULL
            ORDER BY r.cleaned_geometry <-> ST_SetSRID(ST_MakePoint(m.lon, m.lat), 4326)
            LIMIT 1
        ) n ON true
        WHERE m.pack_id = $1 AND m.status <> 'rejected'
        ORDER BY (n.dist_m IS NULL OR n.dist_m > 250),
                 COALESCE(n.position, 2147483647), COALESCE(n.km, 0), m.edited_at
        "#,
    )
    .bind(id)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    let marks: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            let dist_m: Option<f64> = r.get("dist_m");
            let off_track = dist_m.is_none_or(|d| d > 250.0);
            serde_json::json!({
                "id": r.get::<String, _>("id"),
                "op": r.get::<String, _>("op"),
                "kind": r.get::<String, _>("kind"),
                "dir": r.get::<Option<String>, _>("dir"),
                "lat": r.get::<f64, _>("lat"),
                "lon": r.get::<f64, _>("lon"),
                "edited_at": r.get::<chrono::DateTime<chrono::Utc>, _>("edited_at"),
                "edited_by": r.get::<String, _>("edited_by"),
                "status": r.get::<String, _>("status"),
                "ride_id": if off_track { None } else { r.get::<Option<Uuid>, _>("ride_id") },
                "ride_name": if off_track { None } else { r.get::<Option<String>, _>("ride_name") },
                "km": if off_track { None } else { r.get::<Option<f64>, _>("km") },
                "off_track": off_track,
            })
        })
        .collect();

    let baked: i64 = sqlx::query(
        "SELECT count(*) AS n FROM pack_mark_edits WHERE pack_id = $1 AND status = 'accepted'",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .map_err(internal)?
    .get("n");

    Ok(Json(serde_json::json!({ "marks": marks, "accepted": baked })))
}

// ---- Accept / reject ----

#[derive(Debug, Deserialize)]
struct StatusBody {
    status: String,
}

/// Set one mark's status, or `{mark_id} = "all"` to accept every pending one.
/// Either way the pack's `updated_at` bumps so the existing stale banner
/// nudges a refresh.
async fn set_mark_status(
    Extension(pool): Extension<PgPool>,
    AxumPath((id, mark_id)): AxumPath<(Uuid, String)>,
    Json(body): Json<StatusBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if body.status != "accepted" && body.status != "rejected" {
        return Err(bad_request("status must be accepted or rejected"));
    }
    let changed = if mark_id == "all" {
        if body.status != "accepted" {
            return Err(bad_request("bulk update only supports accepting"));
        }
        sqlx::query(
            "UPDATE pack_mark_edits SET status = 'accepted' WHERE pack_id = $1 AND status = 'pending'",
        )
        .bind(id)
        .execute(&pool)
        .await
        .map_err(internal)?
        .rows_affected()
    } else {
        sqlx::query("UPDATE pack_mark_edits SET status = $3 WHERE pack_id = $1 AND id = $2")
            .bind(id)
            .bind(&mark_id)
            .bind(&body.status)
            .execute(&pool)
            .await
            .map_err(internal)?
            .rows_affected()
    };
    if changed == 0 && mark_id != "all" {
        return Err((StatusCode::NOT_FOUND, format!("no mark {mark_id}")));
    }
    if changed > 0 {
        sqlx::query("UPDATE packs SET updated_at = now() WHERE id = $1")
            .bind(id)
            .execute(&pool)
            .await
            .map_err(internal)?;
    }
    Ok(Json(serde_json::json!({ "updated": changed })))
}

/// Accepted marks in DingoNav wire shape, for baking into the bundle.
pub async fn accepted_marks(pool: &PgPool, pack_id: Uuid) -> Result<Vec<MarkEdit>, ApiError> {
    let rows = sqlx::query(
        r#"
        SELECT id, op, kind, dir, lat, lon,
               (extract(epoch FROM edited_at) * 1000)::bigint AS t, edited_by
        FROM pack_mark_edits WHERE pack_id = $1 AND status = 'accepted'
        ORDER BY edited_at
        "#,
    )
    .bind(pack_id)
    .fetch_all(pool)
    .await
    .map_err(internal)?;
    Ok(rows
        .iter()
        .map(|r| MarkEdit {
            id: Some(r.get("id")),
            op: r.get("op"),
            kind: Some(r.get("kind")),
            dir: r.get("dir"),
            la: r.get("lat"),
            lo: r.get("lon"),
            t: r.get("t"),
            by: Some(r.get("edited_by")),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reference values computed with DingoNav's actual JS turnEditId
    /// (node, 2026-07-18) — this pins the Rust port to the phone's algorithm,
    /// including JS shortest-round-trip number stringification ("-33" not
    /// "-33.0").
    #[test]
    fn hash_matches_dingonav() {
        assert_eq!(dn_hash_id("add", -32.856001, 150.081774, 1752871320000), "1mqc30m");
        assert_eq!(dn_hash_id("remove", -33.0, 150.85, 1752871330001), "uinepm");
    }

    #[test]
    fn sanitize_defaults_and_rejects() {
        let e = |op: &str, kind: Option<&str>| MarkEdit {
            id: None,
            op: op.into(),
            kind: kind.map(String::from),
            dir: None,
            la: -32.8,
            lo: 150.1,
            t: 1_752_871_320_000,
            by: None,
        };
        let turn = sanitize_edit(e("add", None)).unwrap();
        assert_eq!(turn.kind.as_deref(), Some("turn"));
        assert_eq!(turn.by.as_deref(), Some("rider"));
        assert!(turn.id.is_some());
        assert_eq!(sanitize_edit(e("add", Some("danger"))).unwrap().kind.as_deref(), Some("danger"));
        // Junk kind collapses to turn; junk op / spot / bad coords are skipped.
        assert_eq!(
            sanitize_edit(e("add", Some("DROP TABLE"))).unwrap().kind.as_deref(),
            Some("turn")
        );
        assert!(sanitize_edit(e("spot", None)).is_none());
        assert!(sanitize_edit(e("explode", None)).is_none());
        let mut bad = e("add", None);
        bad.la = 91.0;
        assert!(sanitize_edit(bad).is_none());
        // All nine kinds pass through.
        for k in KINDS {
            assert_eq!(sanitize_edit(e("add", Some(k))).unwrap().kind.as_deref(), Some(k));
        }
    }

    #[test]
    fn ntfy_lines_parse_and_filter() {
        let body = concat!(
            r#"{"id":"a1","time":1,"event":"open","topic":"dingonav-kandos2026"}"#, "\n",
            r#"{"id":"a2","time":2,"event":"message","topic":"t","message":"{\"k\":\"turn\",\"id\":\"k3j9x2\",\"op\":\"add\",\"kind\":\"danger\",\"la\":-32.856001,\"lo\":150.081774,\"t\":1752871320000,\"by\":\"Macca\"}"}"#, "\n",
            r#"{"id":"a3","time":3,"event":"message","topic":"t","message":"{\"k\":\"pos\",\"la\":-32.8,\"lo\":150.0}"}"#, "\n",
            r#"{"id":"a4","time":4,"event":"message","topic":"t","message":"not json at all"}"#, "\n",
            r#"{"id":"a5","time":5,"event":"message","topic":"t","message":"{\"k\":\"turn\",\"op\":\"remove\",\"la\":-32.9,\"lo\":150.2,\"t\":1752871330000}"}"#, "\n",
            "garbage line", "\n",
        );
        let edits = parse_ntfy_lines(body);
        assert_eq!(edits.len(), 2);
        assert_eq!(edits[0].id.as_deref(), Some("k3j9x2"));
        assert_eq!(edits[0].kind.as_deref(), Some("danger"));
        assert_eq!(edits[1].op, "remove");
        assert_eq!(edits[1].id, None); // sanitize_edit fills it later
    }

    #[test]
    fn topic_and_ride_name() {
        assert_eq!(mint_ride_name("Kandos", 2026), "Kandos2026");
        assert_eq!(mint_ride_name("Dunns Swamp!", 2026), "DunnsSwamp2026");
        assert_eq!(mint_ride_name("---", 2026), "pack2026");
        // A pack named with the year keeps it single, not doubled.
        assert_eq!(mint_ride_name("Kandos_2026", 2026), "Kandos2026");
        assert_eq!(mint_ride_name("Kandos 2026", 2026), "Kandos2026");
        assert_eq!(mark_topic("Kandos2026"), "dingonav-kandos2026");
        assert_eq!(mark_topic("DunnsSwamp2026"), "dingonav-dunnsswamp2026");
    }

    #[test]
    fn mark_serializes_to_dn_wire_shape() {
        let m = MarkEdit {
            id: Some("k3j9x2".into()),
            op: "add".into(),
            kind: Some("danger".into()),
            dir: None,
            la: -32.856001,
            lo: 150.081774,
            t: 1752871320000,
            by: Some("Macca".into()),
        };
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["la"], -32.856001);
        assert_eq!(v["kind"], "danger");
        assert!(v.get("dir").is_none()); // absent, not null — old DN clients iterate keys
        let turn = MarkEdit { dir: Some("L".into()), ..m };
        assert_eq!(serde_json::to_value(&turn).unwrap()["dir"], "L");
    }
}
