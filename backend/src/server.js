const express = require('express');
const cors = require('cors');
const { randomUUID } = require('crypto');
const { pool, initDb } = require('./db');
const { sendNotification, recipientsForSite } = require('./mailer');
const rateLimit = require('express-rate-limit');

const app = express();
const port = process.env.PORT || 4000;

const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
  : null;

// CORS
if (corsOrigins && corsOrigins.length) {
  app.use(cors({ origin: corsOrigins }));
} else {
  app.use(cors()); // allow all in dev
}

// When behind a proxy/CDN, enable to ensure correct IP detection for rate limiting
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

// Per-minute limiter: 5 requests per IP per minute, counted per-route
const perRouteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    // Use IP + path to isolate counters per route
    const ip = (req.ip || req.headers['x-forwarded-for'] || '').toString();
    return `${ip}|${req.path}`;
  },
  handler: (req, res) => {
    return res.status(429).json({ error: 'Too many submissions from this IP, please try again later.' });
  },
});

// Helper to get client IP (works with proxies when trust proxy is enabled externally)
function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) {
    return xf.split(',')[0].trim();
  }
  // req.ip may include ::ffff:
  return (req.ip || req.connection?.remoteAddress || '').replace('::ffff:', '') || 'unknown';
}

// Alert recipients (comma-separated)
function alertRecipients() {
  const envList = (process.env.ALERT_RECIPIENTS || 'edoardo.genissel@example.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return envList;
}

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Active visits for a site (today), for co-activity warnings
app.get('/api/visits/active-site', perRouteLimiter, async (req, res) => {
  try {
    const { powerPlant } = req.query;
    if (!powerPlant || typeof powerPlant !== 'string' || !powerPlant.trim()) {
      return res.status(400).json({ error: 'powerPlant is required' });
    }
    const { rows } = await pool.query(
      `SELECT id, turbine_id, technicians, reason, comment, check_in, check_out,
              power_plant, equipment_name
       FROM visits
       WHERE power_plant = $1 AND check_out IS NULL
         AND UPPER(COALESCE(status, 'IN')) = 'IN'
         AND DATE(check_in AT TIME ZONE 'UTC') = DATE(now() AT TIME ZONE 'UTC')
       ORDER BY check_in DESC` ,
      [powerPlant.trim()]
    );
    return res.json({ count: rows.length, visits: rows });
  } catch (err) {
    console.error('[active-site] error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/visits/checkin', perRouteLimiter, async (req, res) => {
  try {
    const {
      turbineId,
      technicians,
      reason,
      comment,
      powerPlant, // aka park / site name
      equipmentName, // optional
      maintenanceCompany,
      status, // IN/OUT text
      malfunctionType,
    } = req.body || {};

    // Allow missing turbineId: generate a fallback identifier
    const turbine = (typeof turbineId === 'string' && turbineId.trim())
      ? turbineId.trim()
      : (powerPlant ? `SITE-${powerPlant}` : 'N/A');

    let techs = [];
    if (Array.isArray(technicians)) {
      techs = technicians.map((t) => String(t).trim()).filter(Boolean);
    } else if (typeof technicians === 'string') {
      techs = technicians
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    if (!techs.length) {
      return res.status(400).json({ error: 'At least one technician name is required' });
    }

    // dedupe names
    techs = Array.from(new Set(techs));

    const id = randomUUID();
    const q = `
      INSERT INTO visits (
        id, turbine_id, technicians, reason, comment,
        power_plant, equipment_name, maintenance_company, status, malfunction_type
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, turbine_id, technicians, reason, comment, check_in, check_out,
                power_plant, equipment_name, maintenance_company, status, malfunction_type
    `;

    const { rows } = await pool.query(q, [
      id,
      turbine,
      techs,
      reason || null,
      comment || null,
      powerPlant || null,
      equipmentName || null,
      maintenanceCompany || null,
      status || null,
      malfunctionType || null,
    ]);

    // Co-activity: is someone else already IN today on the same power_plant?
    let coActivity = false;
    if (powerPlant) {
      const { rows: co } = await pool.query(
        `SELECT COUNT(*)::int AS cnt
         FROM visits
         WHERE power_plant = $1 AND check_out IS NULL AND id <> $2
           AND UPPER(COALESCE(status, 'IN')) = 'IN'
           AND DATE(check_in AT TIME ZONE 'UTC') = DATE(now() AT TIME ZONE 'UTC')`,
        [powerPlant, id]
      );
      coActivity = (co[0]?.cnt || 0) > 0;
    }

    // Email notify (best-effort)
    try {
      if (powerPlant) {
        const recipients = recipientsForSite(powerPlant);
        if (recipients.length) {
          const subject = `[IN] ${powerPlant}${equipmentName ? ' - ' + equipmentName : ''}`;
          const text = `Check-IN\nSite: ${powerPlant}\nEquipment: ${equipmentName || '-'}\nTechs: ${techs.join(', ')}\nCompany: ${maintenanceCompany || '-'}\nReason: ${reason || '-'}\nMalfunction: ${malfunctionType || '-'}\n`; 
          await sendNotification(subject, text, recipients);
        }
      }
    } catch (e) {
      console.warn('[mail] send failed', e.message);
    }

    return res.status(201).json({ visit: rows[0], coActivity });
  } catch (err) {
    console.error('[checkin] error', err);
    try {
      // Best-effort: mark incoming last row for this request as rejected unless already finalized
      if (err && err.code === 'SITE_BLOCKED') {
        // already handled
      }
    } catch {}
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/visits/checkout', perRouteLimiter, async (req, res) => {
  try {
    const { visitId } = req.body || {};

    if (!visitId || typeof visitId !== 'string') {
      return res.status(400).json({ error: 'visitId is required' });
    }

    const q = `
      UPDATE visits
      SET check_out = now()
      WHERE id = $1 AND check_out IS NULL
      RETURNING id, check_out
    `;

    const { rows } = await pool.query(q, [visitId]);

    if (!rows.length) {
      return res
        .status(404)
        .json({ error: 'Active visit not found or already checked out' });
    }

    // Load for email context
    try {
      const { rows: ctx } = await pool.query(
        `SELECT power_plant, equipment_name, turbine_id, technicians FROM visits WHERE id = $1`,
        [visitId]
      );
      const v = ctx[0];
      if (v?.power_plant) {
        const recipients = recipientsForSite(v.power_plant);
        if (recipients.length) {
          const subject = `[OUT] ${v.power_plant}${v.equipment_name ? ' - ' + v.equipment_name : ''}`;
          const text = `Check-OUT\nSite: ${v.power_plant}\nEquipment: ${v.equipment_name || '-'}\nTurbineId: ${v.turbine_id}\nTechs: ${(v.technicians||[]).join(', ')}\n`;
          await sendNotification(subject, text, recipients);
        }
      }
    } catch (e) {
      console.warn('[mail] send failed', e.message);
    }

    return res.json({ visitId: rows[0].id, checkOut: rows[0].check_out });
  } catch (err) {
    console.error('[checkout] error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/visits/:id', perRouteLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT id, turbine_id, technicians, reason, comment, check_in, check_out FROM visits WHERE id = $1`,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Not found' });
    }

    return res.json({ visit: rows[0] });
  } catch (err) {
    console.error('[get visit] error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/visits/active', perRouteLimiter, async (req, res) => {
  try {
    const { turbineId } = req.query;

    if (!turbineId || typeof turbineId !== 'string' || !turbineId.trim()) {
      return res.status(400).json({ error: 'turbineId is required' });
    }

    const { rows } = await pool.query(
      `SELECT id, turbine_id, technicians, reason, comment, check_in, check_out,
              power_plant, equipment_name
       FROM visits
       WHERE turbine_id = $1 AND check_out IS NULL
       ORDER BY check_in DESC
       LIMIT 1`,
      [turbineId.trim()]
    );

    if (!rows.length) {
      return res.json({ visit: null });
    }

    return res.json({ visit: rows[0] });
  } catch (err) {
    console.error('[active visit] error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Fallback error handler
app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

initDb()
  .then(() => {
    app.listen(port, () => {
      console.log(`[API] Listening on http://localhost:${port}`);
    });
  })
  .catch((err) => {
    console.error('[DB] init failed', err);
    process.exit(1);
  });
