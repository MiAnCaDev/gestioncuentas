const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
const core = require('./db');
const { db } = core;

/* --- administrador inicial --- */
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const { ADMIN_USER, ADMIN_PASSWORD, ADMIN_TELEGRAM_ID } = process.env;
  if (ADMIN_USER && ADMIN_PASSWORD) {
    const r = core.createUser(ADMIN_USER, ADMIN_PASSWORD, ADMIN_TELEGRAM_ID || null, 1);
    console.log(r.error ? 'Error creando admin: ' + r.error : 'Administrador creado: ' + ADMIN_USER);
  } else console.error('No hay usuarios. Define ADMIN_USER y ADMIN_PASSWORD en .env y reinicia.');
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // detrás del túnel de Cloudflare
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, f) => { if (f.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } // evita ver una versión antigua de la web
}));

const send = (res, r) => r.error ? res.status(r.status || 400).json({ error: r.error, count: r.count }) : res.json(r);
const SESSION_MS = 30 * 86400e3;

/* --- sesiones --- */
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(c => c[0]));
}
function auth(req, res, next) {
  const t = cookies(req).sid;
  const u = t && db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(t, Date.now());
  if (!u) return res.status(401).json({ error: 'No autenticado' });
  req.user = u; req.token = t;
  next();
}
const admin = (req, res, next) => req.user.is_admin ? next() : res.status(403).json({ error: 'Solo el administrador' });

const attempts = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip, a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username || ''));
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) {
    a.n++; attempts.set(ip, a);
    return res.status(401).json({ error: 'Acceso denegado: usuario o contraseña incorrectos. Solo pueden entrar usuarios registrados.' });
  }
  attempts.delete(ip);
  db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)').run(token, u.id, Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.post('/api/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token=?').run(req.token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({
  username: req.user.username, telegram_id: req.user.telegram_id, is_admin: !!req.user.is_admin,
  daily_report: !!req.user.daily_report, monthly_report: !!req.user.monthly_report, theme: req.user.theme
}));
app.patch('/api/me/theme', auth, (req, res) => send(res, core.setTheme(req.user.id, (req.body || {}).theme)));
app.patch('/api/me/prefs', auth, (req, res) => send(res, core.setReportPrefs(req.user.id, req.body || {})));
app.post('/api/me/password', auth, (req, res) => {
  const { current, password, confirm } = req.body || {};
  send(res, core.changeOwnPassword(req.user.id, req.token, current, password, confirm));
});

/* --- tipos --- */
app.get('/api/types', auth, (req, res) => res.json(core.listTypes(req.user.id)));
app.post('/api/types', auth, (req, res) => send(res, core.addType(req.user.id, req.body.name)));
app.delete('/api/types/:id', auth, (req, res) => send(res, core.deleteType(req.user.id, Number(req.params.id), req.query.reassign)));

/* --- cuentas --- */
app.get('/api/accounts', auth, (req, res) => res.json(core.accountsWithBalance(req.user.id)));
app.post('/api/accounts', auth, (req, res) => send(res, core.addAccount(req.user.id, req.body.name, req.body.joint, req.body.balance)));
app.patch('/api/accounts/:id', auth, (req, res) => {
  const id = Number(req.params.id), b = req.body || {};
  if (b.active !== undefined) return send(res, core.setActive(req.user.id, id, b.active));
  if (b.real_balance !== undefined) return send(res, core.setRealBalance(req.user.id, id, core.toCents(b.real_balance)));
  res.status(400).json({ error: 'Nada que modificar' });
});

/* --- movimientos --- */
app.get('/api/movements', auth, (req, res) => res.json(core.listMovements(req.user.id, req.query)));
app.post('/api/movements', auth, (req, res) => send(res, core.addMovement(req.user.id, req.body || {})));
app.patch('/api/movements/:id', auth, (req, res) => send(res, core.editMovement(req.user.id, Number(req.params.id), req.body.field, req.body.value)));
app.delete('/api/movements/:id', auth, (req, res) => send(res, core.deleteMovement(req.user.id, Number(req.params.id))));

/* --- estadísticas --- */
app.get('/api/evolution', auth, (req, res) => res.json(core.evolution(req.user.id, req.query.joint === '1')));
app.get('/api/typestats', auth, (req, res) => res.json(core.typeStats(req.user.id, Number(req.query.months ?? 24))));

app.get('/api/export.csv', auth, (req, res) => {
  const { csv } = core.exportCsv(req.user.id);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="gastos_${core.fmtDate(new Date()).slice(0, 10)}.csv"`);
  res.send(csv);
});

/* --- usuarios (solo admin) --- */
app.get('/api/users', auth, admin, (req, res) =>
  res.json(db.prepare('SELECT id,username,telegram_id,is_admin FROM users ORDER BY username').all()));
app.post('/api/users', auth, admin, (req, res) => {
  const { username, password, telegram_id } = req.body || {};
  send(res, core.createUser(username, password, telegram_id, 0));
});
app.patch('/api/users/:id', auth, admin, (req, res) => {
  const { telegram_id, password } = req.body || {};
  send(res, core.updateUser(Number(req.params.id), { telegram_id, password }));
});
app.delete('/api/users/:id', auth, admin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado' }));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Web escuchando en :${port} (TZ=${process.env.TZ || 'sistema'})`));

require('./bot')(core);
