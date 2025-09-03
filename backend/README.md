# Wind Turbine Tracker – Backend

Express + PostgreSQL API to record technicians check-in/out on wind turbines.

## Setup

1. Clone env template and set your values:
   ```bash
   cp .env.example .env
   # Edit .env and set DATABASE_URL (e.g. postgres://user:pass@localhost:5432/windturbine)
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run the server (dev with auto-reload requires nodemon):
   ```bash
   # dev
   npm run dev
   # or prod
   npm start
   ```

On first start the DB schema is created automatically.

## Environment

- DATABASE_URL: Postgres connection string
- PGSSL: set to `true` if your provider requires SSL (uses rejectUnauthorized: false)
- CORS_ORIGIN: optional comma-separated list of allowed origins (empty = allow all)
- PORT: API port (default 4000)

## Endpoints

- `GET /health` → `{ ok: true }`
- `POST /api/visits/checkin`
  - Body: `{ turbineId: string, technicians: string[] | string, reason?: string, comment?: string }`
  - Returns: `{ visit: { id, turbine_id, technicians, reason, comment, check_in, check_out } }`
- `POST /api/visits/checkout`
  - Body: `{ visitId: string }`
  - Returns: `{ visitId, checkOut }`
- `GET /api/visits/:id`
  - Returns visit by id
- `GET /api/visits/active?turbineId=WT-123`
  - Returns active (unchecked-out) visit for the turbine or `visit: null`

## Notes

- The `technicians` field is stored as a Postgres `text[]` to support multiple names.
- Recommended QR format for frontend: `https://your-frontend.example/form?turbineId=WT-123`.
