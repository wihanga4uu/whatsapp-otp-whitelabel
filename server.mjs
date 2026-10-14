import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Boom } from '@hapi/boom';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, Browsers } from '@whiskeysockets/baileys';

const ROOT = process.cwd();
const AUTH_DIR = path.join(ROOT, 'baileys_auth_info');
const LOCK_FILE = path.join(ROOT, '.otp-bot.lock');

const PORT = Number(process.env.PORT || 3000);
const BIND_HOST = String(process.env.BIND_HOST || '127.0.0.1');
const API_KEY = String(process.env.API_KEY || '').trim();
const DEFAULT_BUSINESS_NAME = String(process.env.BUSINESS_NAME || 'CROWN ASIA').trim();
const DEFAULT_BUSINESS_WEBSITE = String(process.env.BUSINESS_WEBSITE || '').trim();
const DEFAULT_SUPPORT_CONTACT = String(process.env.SUPPORT_CONTACT || '').trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();
const SETTINGS_FILE = path.join(ROOT, 'brand-settings.json');

const OTP_EXPIRY_SECONDS = Number(process.env.OTP_EXPIRY_SECONDS || 300);
const OTP_RESEND_SECONDS = Number(process.env.OTP_RESEND_SECONDS || 60);
const MAX_VERIFY_ATTEMPTS = Number(process.env.MAX_VERIFY_ATTEMPTS || 5);

const AUTO_RECONNECT = String(process.env.AUTO_RECONNECT || 'true').toLowerCase() === 'true';
const RECONNECT_MIN_SECONDS = Math.max(2, Number(process.env.RECONNECT_MIN_SECONDS || 3));
const RECONNECT_MAX_SECONDS = Math.max(RECONNECT_MIN_SECONDS, Number(process.env.RECONNECT_MAX_SECONDS || 60));
const HEALTH_CHECK_SECONDS = Math.max(15, Number(process.env.HEALTH_CHECK_SECONDS || 30));
const STALE_CONNECTION_SECONDS = Math.max(60, Number(process.env.STALE_CONNECTION_SECONDS || 180));

const logger = pino({ level: 'silent' });

let sock = null;
let waReady = false;
let waState = 'STARTING';
let reconnectTimer = null;
let healthTimer = null;
let shuttingDown = false;
let connecting = false;
let reconnectAttempt = 0;
let lastDisconnectCode = null;
let lastConnectedAt = null;
let lastConnectionEventAt = Date.now();

const otpStore = new Map();
const lastSentAt = new Map();

const normalizePhone = (v) => String(v || '').replace(/[^\d]/g, '');
const phoneToJid = (p) => `${normalizePhone(p)}@s.whatsapp.net`;
const generateOtp = () => crypto.randomInt(100000, 1000000).toString();
const hashOtp = (p, o) => crypto.createHash('sha256').update(`${p}:${o}:${API_KEY}`).digest('hex');

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    if (pid && pid !== process.pid && isPidAlive(pid)) {
      console.error(`Bot already running. PID ${pid}`);
      process.exit(2);
    }
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
}

function releaseLock() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return;
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {}
}



const DEFAULT_BRAND_SETTINGS = {
  businessName: DEFAULT_BUSINESS_NAME || 'CROWN ASIA',
  adminPanelTitle: `${DEFAULT_BUSINESS_NAME || 'CROWN ASIA'} Admin`,
  brandTagline: 'Secure WhatsApp Verification & Messaging',
  website: DEFAULT_BUSINESS_WEBSITE,
  supportContact: DEFAULT_SUPPORT_CONTACT,
  otpTemplate: `*{{BUSINESS_NAME}}*\n\nYour verification code is: *{{OTP}}*\n\nThis code expires in {{MINUTES}} minutes.\nFor your security, do not share this code with anyone.{{WEBSITE_LINE}}{{SUPPORT_LINE}}`,
  templates: [
    {
      id: 'account-approved',
      name: 'Account Approved',
      content: `*{{BUSINESS_NAME}}*\n\nHello {{NAME}},\n\nYour account has been approved successfully.`,
    },
    {
      id: 'registration-success',
      name: 'Registration Success',
      content: `*{{BUSINESS_NAME}}*\n\nHello {{NAME}},\n\nYour registration has been completed successfully.`,
    },
    {
      id: 'payment-confirmed',
      name: 'Payment Confirmed',
      content: `*{{BUSINESS_NAME}}*\n\nHello {{NAME}},\n\nYour payment has been confirmed. Thank you.`,
    },
  ],
};

function sanitizeText(value, max = 4000) {
  return String(value ?? '').slice(0, max);
}

function slugId(value) {
  const base = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || `template-${Date.now()}`;
}

function normalizeTemplates(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const out = [];

  for (const item of items.slice(0, 50)) {
    const name = sanitizeText(item?.name, 80).trim();
    const content = sanitizeText(item?.content, 4000).trim();
    if (!name || !content) continue;

    let id = slugId(item?.id || name);
    let suffix = 2;
    while (seen.has(id)) id = `${slugId(item?.id || name)}-${suffix++}`;
    seen.add(id);

    out.push({ id, name, content });
  }

  return out;
}

function normalizeBrandSettings(input = {}) {
  const merged = {
    ...DEFAULT_BRAND_SETTINGS,
    ...(input && typeof input === 'object' ? input : {}),
  };

  return {
    businessName: sanitizeText(merged.businessName, 100).trim() || DEFAULT_BRAND_SETTINGS.businessName,
    adminPanelTitle: sanitizeText(merged.adminPanelTitle, 120).trim() || `${sanitizeText(merged.businessName, 100).trim() || DEFAULT_BRAND_SETTINGS.businessName} Admin`,
    brandTagline: sanitizeText(merged.brandTagline, 180).trim(),
    website: sanitizeText(merged.website, 300).trim(),
    supportContact: sanitizeText(merged.supportContact, 120).trim(),
    otpTemplate: sanitizeText(merged.otpTemplate, 4000).trim() || DEFAULT_BRAND_SETTINGS.otpTemplate,
    templates: normalizeTemplates(merged.templates?.length ? merged.templates : DEFAULT_BRAND_SETTINGS.templates),
  };
}

function loadBrandSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      const defaults = normalizeBrandSettings(DEFAULT_BRAND_SETTINGS);
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaults, null, 2), 'utf8');
      return defaults;
    }

    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return normalizeBrandSettings(parsed);
  } catch (error) {
    console.warn('[SETTINGS] Could not load brand-settings.json:', error?.message || error);
    return normalizeBrandSettings(DEFAULT_BRAND_SETTINGS);
  }
}

let brandSettings = loadBrandSettings();

function saveBrandSettings(input) {
  const next = normalizeBrandSettings(input);
  const temp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(temp, SETTINGS_FILE);
  brandSettings = next;
  return brandSettings;
}

function businessName() {
  return brandSettings.businessName || DEFAULT_BRAND_SETTINGS.businessName;
}

function findSavedTemplate(id) {
  return brandSettings.templates.find((item) => item.id === String(id || '')) || null;
}

function templateVariables(extra = {}) {
  const websiteLine = brandSettings.website ? `\n\nWebsite: ${brandSettings.website}` : '';
  const supportLine = brandSettings.supportContact ? `\nSupport: ${brandSettings.supportContact}` : '';

  return {
    BUSINESS_NAME: businessName(),
    WEBSITE: brandSettings.website || '',
    SUPPORT: brandSettings.supportContact || '',
    WEBSITE_LINE: websiteLine,
    SUPPORT_LINE: supportLine,
    ...Object.fromEntries(
      Object.entries(extra || {}).map(([key, value]) => [String(key).toUpperCase(), String(value ?? '')])
    ),
  };
}

function renderTemplate(template, extra = {}) {
  const vars = templateVariables(extra);
  return String(template || '').replace(/{{\s*([A-Z0-9_]+)\s*}}/gi, (full, key) => {
    const upper = String(key).toUpperCase();
    return Object.prototype.hasOwnProperty.call(vars, upper) ? vars[upper] : full;
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function publicBrandSettings() {
  return {
    businessName: brandSettings.businessName,
    adminPanelTitle: brandSettings.adminPanelTitle,
    brandTagline: brandSettings.brandTagline,
    website: brandSettings.website,
    supportContact: brandSettings.supportContact,
    otpTemplate: brandSettings.otpTemplate,
    templates: brandSettings.templates,
  };
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || '');
  const out = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function adminSigningSecret() {
  return `${API_KEY}:${ADMIN_PASSWORD}`;
}

function createAdminSessionToken() {
  const expires = Date.now() + (8 * 60 * 60 * 1000);
  const payload = String(expires);
  const sig = crypto
    .createHmac('sha256', adminSigningSecret())
    .update(payload)
    .digest('hex');
  return `${payload}.${sig}`;
}

function verifyAdminSessionToken(token) {
  if (!token || !token.includes('.') || !ADMIN_PASSWORD || !API_KEY) return false;

  try {
    const [payload, sig] = token.split('.');
    const expires = Number(payload);
    if (!Number.isFinite(expires) || Date.now() > expires) return false;

    const expected = crypto
      .createHmac('sha256', adminSigningSecret())
      .update(payload)
      .digest('hex');

    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');

    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function isAdmin(req) {
  const cookies = parseCookies(req);
  return verifyAdminSessionToken(cookies.crown_asia_admin);
}

function setAdminCookie(res, token, secure = false) {
  const attrs = [
    `crown_asia_admin=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=28800',
  ];

  if (secure) attrs.push('Secure');

  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearAdminCookie(res, secure = false) {
  const attrs = [
    'crown_asia_admin=',
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];

  if (secure) attrs.push('Secure');

  res.setHeader('Set-Cookie', attrs.join('; '));
}

function requireAdminSession(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(401).json({ success: false, error: 'Admin login required' });
  }
  next();
}

async function sendTextMessage(phoneInput, messageInput, variables = {}) {
  if (!waReady || !sock) {
    const error = new Error(`WhatsApp not ready. State: ${waState}`);
    error.statusCode = 503;
    throw error;
  }

  const phone = normalizePhone(phoneInput);
  const message = renderTemplate(String(messageInput || '').trim(), { PHONE: normalizePhone(phoneInput), ...variables });

  if (!/^\d{8,15}$/.test(phone)) {
    const error = new Error('Use country code and digits only');
    error.statusCode = 400;
    throw error;
  }

  if (!message || message.length > 2000) {
    const error = new Error('Message must be between 1 and 2000 characters');
    error.statusCode = 400;
    throw error;
  }

  await sock.sendMessage(phoneToJid(phone), { text: message });
  lastConnectionEventAt = Date.now();

  return { phone, messageLength: message.length };
}

function requireApiKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ success: false, error: 'API_KEY not configured' });
  if (req.get('x-api-key') !== API_KEY) return res.status(401).json({ success: false, error: 'Unauthorized' });
  next();
}

const otpRequestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many OTP requests' },
});

const otpVerifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many verification attempts' },
});

const messageSendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many message requests' },
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many admin login attempts' },
});

function reconnectDelayMs(code) {
  // 515 = restart required. Reconnect quickly.
  if (Number(code) === 515) return 1500;

  const exponent = Math.min(reconnectAttempt, 6);
  const seconds = Math.min(
    RECONNECT_MAX_SECONDS,
    RECONNECT_MIN_SECONDS * Math.pow(2, exponent)
  );
  const jitter = Math.floor(Math.random() * 1200);
  return seconds * 1000 + jitter;
}

function scheduleReconnect(reason = 'unknown', code = null) {
  if (!AUTO_RECONNECT || shuttingDown || reconnectTimer) return;

  reconnectAttempt += 1;
  const delay = reconnectDelayMs(code);
  waState = `RECONNECTING_${reconnectAttempt}`;

  console.log(`[WhatsApp] Auto reconnect #${reconnectAttempt} in ${Math.ceil(delay / 1000)}s (${reason}${code ? ` / ${code}` : ''})`);

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await connectWhatsApp();
    } catch (error) {
      connecting = false;
      console.error('[WhatsApp] reconnect error:', error?.message || error);
      scheduleReconnect('connect-error');
    }
  }, delay);
}

function stopHealthWatchdog() {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

function startHealthWatchdog() {
  stopHealthWatchdog();

  healthTimer = setInterval(() => {
    if (shuttingDown || !AUTO_RECONNECT) return;

    const age = Math.floor((Date.now() - lastConnectionEventAt) / 1000);
    const wsOpen = sock?.ws?.isOpen;

    // If Baileys explicitly reports a dead socket, reconnect immediately.
    if (waReady && wsOpen === false) {
      console.warn('[Watchdog] WebSocket is closed while state is READY. Reconnecting...');
      waReady = false;
      waState = 'WATCHDOG_SOCKET_CLOSED';
      try { sock?.end?.(undefined); } catch {}
      sock = null;
      scheduleReconnect('watchdog-socket-closed');
      return;
    }

    // Safety net for a connection stuck in CONNECTING/RECONNECTING for too long.
    if (!waReady && connecting && age > STALE_CONNECTION_SECONDS) {
      console.warn(`[Watchdog] Connection attempt is stale (${age}s). Restarting socket...`);
      connecting = false;
      try { sock?.end?.(undefined); } catch {}
      sock = null;
      scheduleReconnect('watchdog-stale-connect');
    }
  }, HEALTH_CHECK_SECONDS * 1000);
}

async function connectWhatsApp() {
  if (shuttingDown || connecting) return;
  connecting = true;
  waReady = false;
  waState = reconnectAttempt > 0 ? 'RECONNECTING' : 'CONNECTING';
  lastConnectionEventAt = Date.now();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const current = makeWASocket({
    auth: state,
    logger,
    browser: Browsers.windows('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 20_000,
    retryRequestDelayMs: 250,
  });

  sock = current;
  current.ev.on('creds.update', saveCreds);

  current.ev.on('connection.update', (update) => {
    if (sock !== current) return;

    lastConnectionEventAt = Date.now();
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connecting = false;
      waReady = false;
      waState = 'WAITING_FOR_QR';
      reconnectAttempt = 0;

      console.clear();
      console.log('====================================================');
      console.log(` ${businessName()} - WhatsApp V2.4 WHITE-LABEL`);
      console.log(' Engine: Baileys WebSocket');
      console.log(' Scan: WhatsApp > Linked devices > Link a device');
      console.log('====================================================\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      connecting = false;
      waReady = true;
      waState = 'READY';
      reconnectAttempt = 0;
      lastDisconnectCode = null;
      lastConnectedAt = new Date().toISOString();

      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      console.log(`\n[WhatsApp] READY - ${businessName()} messaging is available.`);
      console.log('[WhatsApp] Auto reconnect: ENABLED');
      console.log(`API listening on http://${BIND_HOST}:${PORT}`);
    }

    if (connection === 'close') {
      connecting = false;
      waReady = false;

      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
        ?? lastDisconnect?.error?.output?.statusCode
        ?? null;

      lastDisconnectCode = code;
      const loggedOut = code === DisconnectReason.loggedOut;

      if (loggedOut) {
        waState = 'LOGGED_OUT';
        reconnectAttempt = 0;
        console.log('\n[WhatsApp] Session was logged out/unlinked by WhatsApp.');
        console.log('[WhatsApp] Automatic reconnect cannot restore a revoked session.');
        console.log('[WhatsApp] Run RESET-SESSION.bat and scan a new QR.');
        return;
      }

      waState = `DISCONNECTED_${code ?? 'UNKNOWN'}`;
      console.log(`[WhatsApp] Connection closed (${code ?? 'unknown'}).`);

      if (sock === current) sock = null;
      scheduleReconnect('connection-close', code);
    }
  });
}

async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[SYSTEM] ${sig} - stopping...`);

  if (reconnectTimer) clearTimeout(reconnectTimer);
  stopHealthWatchdog();

  try { sock?.end?.(undefined); } catch {}
  releaseLock();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', releaseLock);

process.on('uncaughtException', (error) => {
  console.error('[SYSTEM] uncaughtException:', error?.message || error);
  if (!shuttingDown) {
    waReady = false;
    connecting = false;
    scheduleReconnect('uncaught-exception');
  }
});

process.on('unhandledRejection', (error) => {
  console.error('[SYSTEM] unhandledRejection:', error?.message || error);
  if (!shuttingDown) {
    waReady = false;
    connecting = false;
    scheduleReconnect('unhandled-rejection');
  }
});

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));

app.get('/', (req, res) => res.type('html').send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(businessName())} - WhatsApp V2.4</title>
<style>
body{font-family:Arial,sans-serif;background:#0b141a;color:#e9edef;padding:40px;margin:0}
.card{max-width:760px;margin:auto;background:#202c33;border:1px solid rgba(255,255,255,.08);border-radius:22px;padding:28px}
.ok{color:#35e58b}.bad{color:#ff8b8b}
a{display:inline-block;margin-top:12px;color:#35e58b;text-decoration:none;font-weight:700}
code{background:#111b21;padding:3px 7px;border-radius:6px}
</style>
</head>
<body>
<div class="card">
<h1>${escapeHtml(businessName())} - WhatsApp V2.4</h1>
<p>Status: <b class="${waReady ? 'ok' : 'bad'}">${waState}</b></p>
<p>Engine: Baileys WebSocket</p><p>Brand: <b>${escapeHtml(businessName())}</b></p>
<p>Auto reconnect: ${AUTO_RECONNECT ? 'ENABLED' : 'DISABLED'}</p>
<p>OTP API: <code>/api/request-otp</code></p>
<p>Message API: <code>/api/send-message</code></p>
<a href="/admin">Open Admin Message Panel →</a>
</div>
</body>
</html>`));

app.get('/api/status', requireApiKey, (req, res) => res.json({
  success: true,
  whatsappReady: waReady,
  state: waState,
  lastConnectedAt,
  lastDisconnectCode,
  reconnectAttempt,
  autoReconnect: AUTO_RECONNECT,
  engine: 'baileys',
  businessName: businessName(),
  templateCount: brandSettings.templates.length,
}));


app.post('/api/send-message', requireApiKey, messageSendLimiter, async (req, res) => {
  try {
    let message = req.body?.message;
    if (req.body?.templateId) {
      const saved = findSavedTemplate(req.body.templateId);
      if (!saved) return res.status(404).json({ success: false, error: 'Template not found' });
      message = saved.content;
    }

    const result = await sendTextMessage(req.body?.phone, message, req.body?.variables || {});

    return res.json({
      success: true,
      message: 'WhatsApp message sent.',
      phone: result.phone,
      messageLength: result.messageLength,
    });
  } catch (error) {
    console.error('[send-message]', error?.message || error);
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || 'Failed to send message',
    });
  }
});

app.get('/admin', (req, res) => {
  const loggedIn = isAdmin(req);
  const brand = publicBrandSettings();
  const brandJson = JSON.stringify(brand).replace(/</g, '\\u003c');

  return res.type('html').send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(brand.adminPanelTitle)}</title>
<style>
*{box-sizing:border-box}body{font-family:Arial,sans-serif;background:#07140d;color:#edf7f0;margin:0;padding:24px}.wrap{max-width:980px;margin:32px auto}.card{background:#10251a;border:1px solid rgba(255,255,255,.09);border-radius:22px;padding:26px;box-shadow:0 25px 70px rgba(0,0,0,.25);margin-bottom:18px}h1,h2{margin-top:0}.muted{color:#9cb5a5;line-height:1.5}.status{display:inline-block;padding:7px 11px;border-radius:999px;background:${waReady ? 'rgba(53,229,139,.1)' : 'rgba(255,110,110,.1)'};color:${waReady ? '#61f0a0' : '#ff9999'};font-weight:800;font-size:13px}label{display:block;margin:16px 0 7px;font-weight:800;font-size:13px}input,textarea,select{width:100%;border:1px solid rgba(255,255,255,.1);background:#081811;color:#fff;border-radius:12px;padding:12px;outline:none}textarea{min-height:140px;resize:vertical}button{border:0;border-radius:12px;padding:12px 16px;font-weight:900;cursor:pointer}.primary{background:#35e58b;color:#032012}.secondary{background:transparent;color:#70f2a9;border:1px solid rgba(255,255,255,.1)}.danger{background:rgba(255,100,100,.12);color:#ffaaaa;border:1px solid rgba(255,100,100,.18)}.notice{margin-top:15px;padding:12px 14px;border-radius:11px;display:none}.ok{display:block;background:rgba(53,229,139,.1);color:#70f2a9}.err{display:block;background:rgba(255,110,110,.1);color:#ffaaaa}.back{color:#70f2a9;text-decoration:none;display:inline-block;margin-bottom:15px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}.templateItem{border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:14px;margin-top:10px}.templateItem h3{margin:0 0 8px}.templateItem pre{white-space:pre-wrap;color:#bcd2c3;background:#081811;padding:12px;border-radius:10px}.help{font-size:12px;color:#89a694;line-height:1.5}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}.tabBtn{background:#0a1d13;color:#bcd2c3;border:1px solid rgba(255,255,255,.08)}.tabBtn.active{background:#35e58b;color:#032012}.panel{display:none}.panel.active{display:block}@media(max-width:720px){.grid{grid-template-columns:1fr}.wrap{margin:10px auto;padding:0}.card{padding:18px}}
</style>
</head>
<body>
<div class="wrap">
<a class="back" href="/">← Status page</a>
<div class="card">
<h1>${escapeHtml(brand.adminPanelTitle)}</h1>
<p class="muted">${escapeHtml(brand.brandTagline)}</p>
<p><span class="status">${waState}</span></p>
${loggedIn ? `
<div class="tabs">
  <button class="tabBtn active" data-tab="send">Send Message</button>
  <button class="tabBtn" data-tab="branding">Brand & OTP</button>
  <button class="tabBtn" data-tab="templates">Templates</button>
</div>

<section id="panel-send" class="panel active">
  <h2>Send WhatsApp Message</h2>
  <p class="muted">Select a saved template or type a custom message.</p>
  <form id="sendForm">
    <div class="grid">
      <div><label>WhatsApp number</label><input id="phone" placeholder="94771234567" inputmode="tel" required></div>
      <div><label>Recipient name (optional)</label><input id="recipientName" placeholder="Student / Customer name"></div>
    </div>
    <label>Saved template</label>
    <select id="sendTemplate"><option value="">Custom message</option></select>
    <label>Message</label>
    <textarea id="message" maxlength="4000" placeholder="Type your message..." required></textarea>
    <p class="help">Available placeholders: {{BUSINESS_NAME}}, {{NAME}}, {{PHONE}}, {{WEBSITE}}, {{SUPPORT}}</p>
    <button class="primary" type="submit">Send WhatsApp Message</button>
  </form>
  <div id="sendNotice" class="notice"></div>
</section>

<section id="panel-branding" class="panel">
  <h2>Brand & OTP Settings</h2>
  <p class="muted">Use the same bot for CROWN ASIA, Southland, or any other client. Changes save to <code>brand-settings.json</code> and apply without restarting.</p>
  <div class="actions">
    <button type="button" class="secondary" id="presetCrown">CROWN ASIA preset</button>
    <button type="button" class="secondary" id="presetSouthland">Southland preset</button>
  </div>
  <form id="brandForm">
    <div class="grid">
      <div><label>Business / Organization name</label><input id="businessName" required></div>
      <div><label>Admin panel title</label><input id="adminPanelTitle"></div>
    </div>
    <label>Tagline</label><input id="brandTagline">
    <div class="grid">
      <div><label>Website</label><input id="website" placeholder="https://example.com"></div>
      <div><label>Support contact</label><input id="supportContact" placeholder="+94XXXXXXXXX"></div>
    </div>
    <label>OTP message template</label>
    <textarea id="otpTemplate" maxlength="4000"></textarea>
    <p class="help">OTP placeholders: {{BUSINESS_NAME}}, {{OTP}}, {{MINUTES}}, {{WEBSITE}}, {{SUPPORT}}, {{WEBSITE_LINE}}, {{SUPPORT_LINE}}</p>
    <button class="primary" type="submit">Save Brand Settings</button>
  </form>
  <div id="brandNotice" class="notice"></div>
</section>

<section id="panel-templates" class="panel">
  <h2>Message Template Library</h2>
  <p class="muted">Create reusable default messages for approvals, registrations, payments, notices, etc.</p>
  <form id="templateForm">
    <input id="templateId" type="hidden">
    <label>Template name</label><input id="templateName" placeholder="Account Approved" required>
    <label>Template content</label><textarea id="templateContent" maxlength="4000" required></textarea>
    <p class="help">Placeholders: {{BUSINESS_NAME}}, {{NAME}}, {{PHONE}}, {{WEBSITE}}, {{SUPPORT}}</p>
    <div class="actions"><button class="primary" type="submit">Save Template</button><button class="secondary" type="button" id="clearTemplate">New Template</button></div>
  </form>
  <div id="templateNotice" class="notice"></div>
  <div id="templateList"></div>
</section>

<div class="actions"><button class="secondary" id="logoutBtn">Admin logout</button></div>

<script>
let BRAND = ${brandJson};
const byId = (id) => document.getElementById(id);
const showNotice = (id, text, ok) => { const n=byId(id); n.textContent=text; n.className='notice '+(ok?'ok':'err'); };
const esc = (v) => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');

function renderSendTemplates(){
  const sel=byId('sendTemplate');
  sel.innerHTML='<option value="">Custom message</option>' + BRAND.templates.map(t=>'<option value="'+esc(t.id)+'">'+esc(t.name)+'</option>').join('');
}
function fillBrandForm(){
  ['businessName','adminPanelTitle','brandTagline','website','supportContact','otpTemplate'].forEach(k=>{ if(byId(k)) byId(k).value=BRAND[k]||''; });
}
function renderTemplateList(){
  const list=byId('templateList');
  list.innerHTML=BRAND.templates.map(t=>'<div class="templateItem"><h3>'+esc(t.name)+'</h3><pre>'+esc(t.content)+'</pre><div class="actions"><button class="secondary" data-edit="'+esc(t.id)+'">Edit</button><button class="danger" data-delete="'+esc(t.id)+'">Delete</button></div></div>').join('');
}
function refreshAll(){ renderSendTemplates(); fillBrandForm(); renderTemplateList(); }

for(const btn of document.querySelectorAll('.tabBtn')) btn.addEventListener('click',()=>{ document.querySelectorAll('.tabBtn').forEach(b=>b.classList.remove('active')); document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active')); btn.classList.add('active'); byId('panel-'+btn.dataset.tab).classList.add('active'); });

byId('sendTemplate').addEventListener('change',()=>{ const t=BRAND.templates.find(x=>x.id===byId('sendTemplate').value); if(t) byId('message').value=t.content; });
byId('sendForm').addEventListener('submit',async(e)=>{ e.preventDefault(); const button=e.submitter; button.disabled=true; try{ const r=await fetch('/api/admin/send-message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:byId('phone').value,message:byId('message').value,variables:{NAME:byId('recipientName').value}})}); const d=await r.json(); showNotice('sendNotice',d.success?'Message sent successfully.':(d.error||'Send failed.'),!!d.success); }catch{showNotice('sendNotice','Could not contact the server.',false)} finally{button.disabled=false;} });

byId('brandForm').addEventListener('submit',async(e)=>{ e.preventDefault(); const payload={businessName:byId('businessName').value,adminPanelTitle:byId('adminPanelTitle').value,brandTagline:byId('brandTagline').value,website:byId('website').value,supportContact:byId('supportContact').value,otpTemplate:byId('otpTemplate').value}; const r=await fetch('/api/admin/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}); const d=await r.json(); if(d.success){BRAND=d.settings;refreshAll();showNotice('brandNotice','Brand settings saved.',true)}else showNotice('brandNotice',d.error||'Save failed.',false); });

byId('presetCrown').addEventListener('click',()=>{byId('businessName').value='CROWN ASIA';byId('adminPanelTitle').value='CROWN ASIA Admin';byId('brandTagline').value='Secure WhatsApp Verification & Messaging';byId('otpTemplate').value='*{{BUSINESS_NAME}}*\\n\\nYour verification code is: *{{OTP}}*\\n\\nThis code expires in {{MINUTES}} minutes.\\nFor your security, do not share this code with anyone.{{WEBSITE_LINE}}{{SUPPORT_LINE}}';});
byId('presetSouthland').addEventListener('click',()=>{byId('businessName').value='SOUTHLAND INTERNATIONAL COLLEGE NETWORK';byId('adminPanelTitle').value='Southland WhatsApp Admin';byId('brandTagline').value='Official Verification & Notification Service';byId('otpTemplate').value='*{{BUSINESS_NAME}}*\\n\\nYour verification code is: *{{OTP}}*\\n\\nThis code expires in {{MINUTES}} minutes.\\nPlease do not share this code with anyone.{{WEBSITE_LINE}}{{SUPPORT_LINE}}';});

byId('templateForm').addEventListener('submit',async(e)=>{ e.preventDefault(); const payload={id:byId('templateId').value,name:byId('templateName').value,content:byId('templateContent').value}; const r=await fetch('/api/admin/templates/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}); const d=await r.json(); if(d.success){BRAND=d.settings;byId('templateForm').reset();refreshAll();showNotice('templateNotice','Template saved.',true)}else showNotice('templateNotice',d.error||'Save failed.',false); });
byId('clearTemplate').addEventListener('click',()=>byId('templateForm').reset());
byId('templateList').addEventListener('click',async(e)=>{ const edit=e.target.dataset.edit, del=e.target.dataset.delete; if(edit){const t=BRAND.templates.find(x=>x.id===edit); if(t){byId('templateId').value=t.id;byId('templateName').value=t.name;byId('templateContent').value=t.content;window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'});}} if(del){if(!confirm('Delete this template?'))return; const r=await fetch('/api/admin/templates/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:del})}); const d=await r.json(); if(d.success){BRAND=d.settings;refreshAll();showNotice('templateNotice','Template deleted.',true)}else showNotice('templateNotice',d.error||'Delete failed.',false);} });

byId('logoutBtn').addEventListener('click',async()=>{await fetch('/api/admin/logout',{method:'POST'});location.reload();});
refreshAll();
</script>
` : `
<p class="muted">Enter the admin password from the RDP bot <code>.env</code> file.</p>
<form id="loginForm"><label>Admin password</label><input id="password" type="password" autocomplete="current-password" required><button class="primary" type="submit">Admin Login</button></form><div id="loginNotice" class="notice"></div>
<script>document.getElementById('loginForm').addEventListener('submit',async(e)=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{const r=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('password').value})});const d=await r.json();if(d.success){location.reload();return;}const n=document.getElementById('loginNotice');n.textContent=d.error||'Login failed.';n.className='notice err';}finally{b.disabled=false;}});</script>
`}
</div>
</div>
</body>
</html>
  `);
});

app.get('/api/admin/settings', requireAdminSession, (req, res) => {
  return res.json({ success: true, settings: publicBrandSettings() });
});

app.post('/api/admin/settings', requireAdminSession, (req, res) => {
  try {
    const current = publicBrandSettings();
    const next = saveBrandSettings({ ...current, ...req.body, templates: current.templates });
    return res.json({ success: true, settings: publicBrandSettings() });
  } catch (error) {
    console.error('[settings-save]', error?.message || error);
    return res.status(500).json({ success: false, error: 'Could not save settings' });
  }
});

app.post('/api/admin/templates/save', requireAdminSession, (req, res) => {
  const name = sanitizeText(req.body?.name, 80).trim();
  const content = sanitizeText(req.body?.content, 4000).trim();
  if (!name || !content) return res.status(400).json({ success: false, error: 'Template name and content are required' });

  const current = publicBrandSettings();
  const requestedId = sanitizeText(req.body?.id, 80).trim();
  let templates = [...current.templates];

  if (requestedId && templates.some((t) => t.id === requestedId)) {
    templates = templates.map((t) => t.id === requestedId ? { ...t, name, content } : t);
  } else {
    let id = slugId(name);
    let n = 2;
    while (templates.some((t) => t.id === id)) id = `${slugId(name)}-${n++}`;
    templates.push({ id, name, content });
  }

  saveBrandSettings({ ...current, templates });
  return res.json({ success: true, settings: publicBrandSettings() });
});

app.post('/api/admin/templates/delete', requireAdminSession, (req, res) => {
  const id = String(req.body?.id || '');
  const current = publicBrandSettings();
  saveBrandSettings({ ...current, templates: current.templates.filter((t) => t.id !== id) });
  return res.json({ success: true, settings: publicBrandSettings() });
});

app.post('/api/admin/login', adminLoginLimiter, (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({
      success: false,
      error: 'ADMIN_PASSWORD is not configured',
    });
  }

  const supplied = String(req.body?.password || '');
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(ADMIN_PASSWORD, 'utf8');

  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok) {
    return res.status(401).json({ success: false, error: 'Invalid admin password' });
  }

  const secure =
    req.secure ||
    String(req.get('x-forwarded-proto') || '').toLowerCase() === 'https';

  setAdminCookie(res, createAdminSessionToken(), secure);
  return res.json({ success: true });
});

app.post('/api/admin/logout', (req, res) => {
  const secure =
    req.secure ||
    String(req.get('x-forwarded-proto') || '').toLowerCase() === 'https';

  clearAdminCookie(res, secure);
  return res.json({ success: true });
});

app.post('/api/admin/send-message', requireAdminSession, messageSendLimiter, async (req, res) => {
  try {
    const result = await sendTextMessage(req.body?.phone, req.body?.message, req.body?.variables || {});

    return res.json({
      success: true,
      message: 'WhatsApp message sent.',
      phone: result.phone,
    });
  } catch (error) {
    console.error('[admin-send-message]', error?.message || error);
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || 'Failed to send message',
    });
  }
});

app.post('/api/request-otp', requireApiKey, otpRequestLimiter, async (req, res) => {
  try {
    if (!waReady || !sock) {
      return res.status(503).json({ success: false, error: `WhatsApp not ready. State: ${waState}` });
    }

    const phone = normalizePhone(req.body.phone);
    if (!/^\d{8,15}$/.test(phone)) {
      return res.status(400).json({ success: false, error: 'Use country code and digits only' });
    }

    const now = Date.now();
    const last = lastSentAt.get(phone) || 0;
    const cooldown = OTP_RESEND_SECONDS * 1000;

    if (now - last < cooldown) {
      return res.status(429).json({
        success: false,
        error: `Please wait ${Math.ceil((cooldown - (now - last)) / 1000)}s`,
      });
    }

    const otp = generateOtp();
    otpStore.set(phone, {
      otpHash: hashOtp(phone, otp),
      expiresAt: now + OTP_EXPIRY_SECONDS * 1000,
      attempts: 0,
    });
    lastSentAt.set(phone, now);

    const text = renderTemplate(brandSettings.otpTemplate, {
      OTP: otp,
      MINUTES: Math.ceil(OTP_EXPIRY_SECONDS / 60),
      PHONE: phone,
    });

    await sock.sendMessage(phoneToJid(phone), { text });
    lastConnectionEventAt = Date.now();

    return res.json({ success: true, message: 'OTP sent via WhatsApp.', expiresIn: OTP_EXPIRY_SECONDS });
  } catch (error) {
    console.error('[request-otp]', error?.message || error);
    return res.status(500).json({ success: false, error: 'Failed to send OTP' });
  }
});

app.post('/api/verify-otp', requireApiKey, otpVerifyLimiter, (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const otp = String(req.body.otp || '').trim();

  if (!/^\d{8,15}$/.test(phone) || !/^\d{6}$/.test(otp)) {
    return res.status(400).json({ success: false, error: 'Invalid phone or OTP format' });
  }

  const entry = otpStore.get(phone);
  if (!entry) return res.status(400).json({ success: false, error: 'No active OTP' });

  if (Date.now() > entry.expiresAt) {
    otpStore.delete(phone);
    return res.status(400).json({ success: false, error: 'OTP expired' });
  }

  entry.attempts++;
  if (entry.attempts > MAX_VERIFY_ATTEMPTS) {
    otpStore.delete(phone);
    return res.status(429).json({ success: false, error: 'Too many incorrect attempts' });
  }

  const a = Buffer.from(hashOtp(phone, otp), 'hex');
  const b = Buffer.from(entry.otpHash, 'hex');

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(400).json({
      success: false,
      error: 'Incorrect OTP',
      attemptsRemaining: Math.max(0, MAX_VERIFY_ATTEMPTS - entry.attempts),
    });
  }

  otpStore.delete(phone);
  return res.json({ success: true, verified: true, message: 'Phone number verified' });
});

acquireLock();
startHealthWatchdog();

app.listen(PORT, BIND_HOST, () => {
  console.log('====================================================');
  console.log(` ${businessName()} WhatsApp V2.4 - WHITE-LABEL TEMPLATES`);
  console.log(' Engine: Baileys WebSocket');
  console.log(` Auto reconnect: ${AUTO_RECONNECT ? 'ON' : 'OFF'}`);
  console.log(` API: http://${BIND_HOST}:${PORT}`);
  console.log('====================================================');
});

connectWhatsApp().catch((error) => {
  connecting = false;
  console.error('[WhatsApp] Startup error:', error?.message || error);
  scheduleReconnect('startup-error');
});
