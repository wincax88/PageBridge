#!/bin/sh
set -eu

api_base_url="${VITE_API_BASE_URL:-/api}"
escaped_api_base_url=$(printf '%s' "$api_base_url" | sed 's/\\/\\\\/g; s/"/\\"/g')

cat > /usr/share/nginx/html/env.js <<EOF
window.__PAGEBRIDGE_CONFIG__ = {
  VITE_API_BASE_URL: "$escaped_api_base_url"
};
EOF

exec nginx -g 'daemon off;'
