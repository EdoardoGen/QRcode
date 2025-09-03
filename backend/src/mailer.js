const nodemailer = require('nodemailer');

function buildTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST) return null;
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: String(SMTP_SECURE) === 'true',
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  return transporter;
}

async function sendNotification(subject, text, toList) {
  const transporter = buildTransport();
  if (!transporter) {
    console.log('[mail] SMTP not configured, skipping email');
    return;
  }
  const from = process.env.SMTP_FROM || 'Wind Tracker <noreply@example.com>';
  const to = toList.join(', ');
  await transporter.sendMail({ from, to, subject, text });
}

function recipientsForSite(powerPlant) {
  try {
    const matrix = JSON.parse(process.env.NOTIFY_MATRIX || '{}');
    const raw = matrix[powerPlant] || matrix.OTHER;
    if (!raw) return [];
    return String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    console.warn('[mail] invalid NOTIFY_MATRIX');
    return [];
  }
}

module.exports = { sendNotification, recipientsForSite };
