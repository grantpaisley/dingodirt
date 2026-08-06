#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

case "${1:-}" in
    start)
        echo "Starting Dingo database..."
        docker compose up -d
        echo "Waiting for database to be ready..."
        until docker compose exec -T db pg_isready -U dingo -d dingo &>/dev/null; do
            sleep 1
        done
        echo "Database is ready!"
        echo "Verifying PostGIS..."
        docker compose exec -T db psql -U dingo -d dingo -c "SELECT PostGIS_Version();"
        ;;
    stop)
        echo "Stopping Dingo database..."
        docker compose stop
        ;;
    reset)
        echo "Resetting Dingo database (this will delete all data)..."
        read -p "Are you sure? [y/N] " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            docker compose down -v
            echo "Database reset complete."
        else
            echo "Cancelled."
        fi
        ;;
    logs)
        docker compose logs -f db
        ;;
    psql)
        docker compose exec db psql -U dingo -d dingo
        ;;
    *)
        echo "Usage: $0 {start|stop|reset|logs|psql}"
        exit 1
        ;;
esac
