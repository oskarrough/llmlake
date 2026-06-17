# Shared freshness warning for commands that read built parquet snapshots.
warn_stale_parquet() {
  local root="$1"

  newest_mtime() {
    { find "$1" -name "$2" -type f -printf '%T@\n' 2>/dev/null || true; } | awk 'NR==1||$1>m{m=$1} END{if(m)print m}'
  }

  local src_m
  local pq_m
  src_m=$(newest_mtime "$root/data/sessions" '*.jsonl')
  pq_m=$(newest_mtime "$root/data/parquet" '*.parquet')
  if [[ -n "$src_m" ]] && { [[ -z "$pq_m" ]] || awk -v src="$src_m" -v pq="$pq_m" 'BEGIN{exit !(src > pq)}'; }; then
    echo "warning: ./data/sessions has files newer than ./data/parquet — run './llmlake build' to refresh." >&2
    echo >&2
  fi
}
