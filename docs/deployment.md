# Production Deployment

PageBridge ships with separate production Dockerfiles so the local development compose file can keep using hot-reload containers.

Required environment variables:

- `WEB_ORIGIN`
- `DATABASE_URL`
- `REDIS_URL`
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- `S3_ENDPOINT`
- `S3_BUCKET`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`

Production traffic must terminate TLS before it reaches the Web and API containers. Put these containers behind a managed load balancer, Caddy, Traefik, nginx, Cloudflare Tunnel, or an equivalent reverse proxy that serves HTTPS and forwards `/api` to the API service.

Optional environment variables:

- `S3_REGION`, defaults to `us-east-1`
- `S3_FORCE_PATH_STYLE`, defaults to `false`
- `S3_SERVER_SIDE_ENCRYPTION`, defaults to `AES256`; set to `aws:kms` when using a KMS key
- `S3_SSE_KMS_KEY_ID`, required when `S3_SERVER_SIDE_ENCRYPTION=aws:kms`
- `VITE_API_BASE_URL`, defaults to `/api`

Run production containers:

```sh
docker compose -f docker-compose.prod.yml up --build -d
```

The API container runs `prisma migrate deploy` before starting `dist/main.js`. Use managed PostgreSQL, Redis, and S3-compatible storage in production; do not reuse the development secrets from `docker-compose.yml`.

Storage encryption:

- New API uploads and presigned uploads include S3 server-side encryption headers when `S3_SERVER_SIDE_ENCRYPTION` is set.
- For AWS S3, keep the default `AES256` or use `aws:kms` plus `S3_SSE_KMS_KEY_ID`.
- For MinIO or another S3-compatible service, verify the provider supports the selected encryption mode before enabling it.

Backup and restore minimums:

- Enable automated PostgreSQL backups with point-in-time recovery.
- Keep object storage versioning or provider-level replication enabled for the PDF bucket.
- Back up Redis only if using it for durable data; PageBridge currently uses Redis for rate limiting and transient behavior.
- Test restore by recovering a database snapshot and confirming files, annotations, reading progress, and S3 object keys still match.
