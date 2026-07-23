# Search Engine 2

Node.js + TypeScript monorepo using npm workspaces.

## Structure

- `server/` — Express + TypeScript backend (port 4000)
- `client/` — React + TypeScript frontend, built with Vite (port 5173)

## Development

Run from the repo root:

- `npm run dev:server` — start the backend with hot reload (tsx watch)
- `npm run dev:client` — start the Vite dev server
- `npm run build` — build both server and client
- `npm run build:server` / `npm run build:client` — build individually

The client dev server proxies `/api/*` requests to `http://localhost:4000`
(configured in `client/vite.config.ts`), so run both `dev:server` and
`dev:client` together during development.

## Conventions

- Server entry point: `server/src/index.ts`
- Client entry point: `client/src/main.tsx`
- Each workspace has its own `package.json` and `tsconfig.json`.
