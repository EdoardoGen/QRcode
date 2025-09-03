const dotenv = require('dotenv');
dotenv.config();

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('[CONFIG] Missing DATABASE_URL env var. Create backend/.env from .env.example');
  process.exit(1);
}

const ssl = process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false;

const pool = new Pool({ connectionString, ssl });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS visits (
      id uuid PRIMARY KEY,
      turbine_id text NOT NULL,
      technicians text[] NOT NULL,
      reason text,
      comment text,
      check_in timestamptz NOT NULL DEFAULT now(),
      check_out timestamptz
    );
  `);
  // Add new optional columns for extended form fields
  await pool.query(`ALTER TABLE visits ADD COLUMN IF NOT EXISTS power_plant text;`);
  await pool.query(`ALTER TABLE visits ADD COLUMN IF NOT EXISTS equipment_name text;`);
  await pool.query(`ALTER TABLE visits ADD COLUMN IF NOT EXISTS maintenance_company text;`);
  await pool.query(`ALTER TABLE visits ADD COLUMN IF NOT EXISTS status text;`);
  await pool.query(`ALTER TABLE visits ADD COLUMN IF NOT EXISTS malfunction_type text;`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_visits_turbine ON visits(turbine_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_visits_active ON visits(turbine_id, check_out);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_visits_powerplant_active ON visits(power_plant, check_out);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_visits_equipment_active ON visits(power_plant, equipment_name, check_out);`);
  console.log('[DB] migrations ensured');
}

module.exports = { pool, initDb };
