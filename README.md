# PageBridge

PageBridge is a Web-first PDF reading, annotation, and sync tool.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Web | React, TypeScript, Vite, TanStack Query, Zustand, Dexie, PDF.js |
| API | NestJS, TypeScript |
| Database | PostgreSQL, Prisma |
| Cache | Redis |
| Storage | S3-compatible storage, MinIO for local development |
| Auth | JWT access and refresh tokens |
| Runtime | Docker Compose |

Realtime sync with Socket.IO is intentionally deferred. MVP uses REST-based incremental sync plus local-first pending changes.

## Project Structure

```text
apps/
  api/      NestJS API
  web/      React Web app
packages/
  shared/   Shared TypeScript types
docs/       Product requirements
```

## Local Development

1. Install dependencies:

```bash
npm install
```

2. Start infrastructure:

```bash
docker compose up postgres redis minio minio-init
```

3. Copy environment files:

```bash
copy apps\api\.env.example apps\api\.env
copy apps\web\.env.example apps\web\.env
```

4. Generate Prisma client and run migrations:

```bash
npm run prisma:generate
npm run prisma:migrate
```

5. Start apps:

```bash
npm run dev:api
npm run dev:web
```

Web: http://localhost:5173

API health: http://localhost:4000/api/health

MinIO console: http://localhost:9001

## Docker Development

```bash
docker compose up --build
```

After first startup, run migrations from the host or inside the API container:

```bash
npm run prisma:migrate
```

## Current Implementation Scope

- Monorepo workspace setup.
- NestJS API with auth, files, annotations, reading progress, and sync modules.
- Prisma schema for users, files, annotations, reading progress, and sync changes.
- Redis and S3-compatible storage service wiring.
- React Web shell with auth, file list, placeholder file creation, local IndexedDB queue foundation.
- Docker Compose for PostgreSQL, Redis, MinIO, API, and Web.

## Next Implementation Steps

1. Add real PDF upload flow using presigned S3 URLs.
2. Render PDFs with PDF.js in the reader panel.
3. Add SVG annotation overlay and text-selection highlighter.
4. Persist local pending changes to IndexedDB and replay them through `/api/sync/changes`.
5. Add refresh-token storage and logout revocation.
