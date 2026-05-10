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

Optional environment variables:

- `S3_REGION`, defaults to `us-east-1`
- `S3_FORCE_PATH_STYLE`, defaults to `false`
- `VITE_API_BASE_URL`, defaults to `/api`

Run production containers:

```sh
docker compose -f docker-compose.prod.yml up --build -d
```

The API container runs `prisma migrate deploy` before starting `dist/main.js`. Use managed PostgreSQL, Redis, and S3-compatible storage in production; do not reuse the development secrets from `docker-compose.yml`.
