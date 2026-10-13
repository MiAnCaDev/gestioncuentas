const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const file = process.env.DB_PATH || './data/gastos.db';
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  telegram_id INTEGER UNIQUE,
  is_admin INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS types(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE(user_id, name)
);
-- Importes siempre en céntimos (enteros) para evitar errores de redondeo.
-- real_balance = saldo real indicado por el usuario. El saldo calculado es siempre la suma de los movimientos.
-- Al crear una cuenta con saldo distinto de 0 se inserta un movimiento "situación inicial" (tipo "Otros", initial=1).
CREATE TABLE IF NOT EXISTS accounts(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  joint INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  real_balance INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS movements(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type_id INTEGER NOT NULL REFERENCES types(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  description TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL,
  related_id INTEGER REFERENCES movements(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  initial INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mov_user_date ON movements(user_id, date);
CREATE INDEX IF NOT EXISTS idx_mov_account ON movements(account_id);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
`);

// Migración: preferencias de informes por usuario (los usuarios existentes mantienen los informes activados).
const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!userCols.includes('daily_report')) db.exec('ALTER TABLE users ADD COLUMN daily_report INTEGER NOT NULL DEFAULT 1');
if (!userCols.includes('monthly_report')) db.exec('ALTER TABLE users ADD COLUMN monthly_report INTEGER NOT NULL DEFAULT 1');

/* ---------- utilidades ---------- */
const pad = n => String(n).padStart(2, '0');
const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const nowStr = () => fmtDate(new Date());
const toCents = v => {
  if (v === null || v === undefined) return null;
  let s = String(v).trim().replace(/\s/g, '').replace('€', '').replace(',', '.');
  if (s === '' || !/^[-+]?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
};
const eur = c => (c / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const sg = c => (c > 0 ? '+' : '') + eur(c);
const owned = (table, uid, id) => db.prepare(`SELECT * FROM ${table} WHERE id=? AND user_id=?`).get(id, uid);

/* ---------- usuarios ---------- */
const PW_RULES = 'La contraseña debe tener entre 8 y 64 caracteres, con al menos una mayúscula, una minúscula y un número. Se admiten símbolos habituales (! @ # $ % & * ...), pero no espacios ni caracteres especiales raros.';
function checkPassword(pw) {
  pw = String(pw ?? '');
  const ok = pw.length >= 8 && pw.length <= 64 && /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw) && /^[\x21-\x7E]+$/.test(pw);
  return ok ? null : PW_RULES;
}

const DEFAULT_TYPES = ['Comida', 'Transporte', 'Diversión', 'Mercancía', 'Otros'];
const DEFAULT_TYPE = 'Otros'; // tipo por defecto: no se puede eliminar

function createUser(username, password, telegramId, isAdmin = 0) {
  username = String(username || '').trim();
  if (!/^[\w.-]{3,32}$/.test(username)) return { error: 'Usuario inválido (3-32 caracteres: letras, números, . _ -)' };
  const pe = checkPassword(password);
  if (pe) return { error: pe };
  const tg = telegramId === '' || telegramId == null ? null : Number(telegramId);
  if (tg !== null && !Number.isInteger(tg)) return { error: 'ID de Telegram inválido' };
  try {
    const id = db.transaction(() => {
      const uid = db.prepare('INSERT INTO users(username,password_hash,telegram_id,is_admin) VALUES(?,?,?,?)')
        .run(username, bcrypt.hashSync(password, 10), tg, isAdmin).lastInsertRowid;
      const ins = db.prepare('INSERT INTO types(user_id,name) VALUES(?,?)');
      DEFAULT_TYPES.forEach(n => ins.run(uid, n));
      return uid;
    })();
    return { id: Number(id) };
  } catch (e) {
    return { error: /UNIQUE/.test(e.message) ? 'El usuario o el ID de Telegram ya existe' : e.message };
  }
}

function updateUser(id, { telegram_id, password }) {
  try {
    if (telegram_id !== undefined) {
      const tg = telegram_id === '' || telegram_id === null ? null : Number(telegram_id);
      if (tg !== null && !Number.isInteger(tg)) return { error: 'ID de Telegram inválido' };
      db.prepare('UPDATE users SET telegram_id=? WHERE id=?').run(tg, id);
    }
    if (password !== undefined) {
      const pe = checkPassword(password);
      if (pe) return { error: pe };
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password, 10), id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    }
    return { ok: true };
  } catch (e) {
    return { error: /UNIQUE/.test(e.message) ? 'Ese ID de Telegram ya está asignado a otro usuario' : e.message };
  }
}

// Cambio de contraseña por el propio usuario (no puede tocar su ID de Telegram).
function changeOwnPassword(uid, token, current, pw, confirm) {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  if (!bcrypt.compareSync(String(current || ''), u.password_hash)) return { error: 'La contraseña actual no es correcta' };
  if (pw !== confirm) return { error: 'Las contraseñas nuevas no coinciden' };
  const pe = checkPassword(pw);
  if (pe) return { error: pe };
  if (bcrypt.compareSync(pw, u.password_hash)) return { error: 'La nueva contraseña debe ser distinta de la actual' };
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(pw, 10), uid);
  db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(uid, token); // cierra el resto de sesiones
  return { ok: true };
}

function setReportPrefs(uid, { daily_report, monthly_report } = {}) {
  for (const v of [daily_report, monthly_report]) if (v !== undefined && typeof v !== 'boolean') return { error: 'Valor inválido' };
  if (daily_report !== undefined) db.prepare('UPDATE users SET daily_report=? WHERE id=?').run(daily_report ? 1 : 0, uid);
  if (monthly_report !== undefined) db.prepare('UPDATE users SET monthly_report=? WHERE id=?').run(monthly_report ? 1 : 0, uid);
  const u = db.prepare('SELECT daily_report, monthly_report FROM users WHERE id=?').get(uid);
  return { ok: true, daily_report: !!u.daily_report, monthly_report: !!u.monthly_report };
}

const userByTelegram = tg => db.prepare('SELECT * FROM users WHERE telegram_id=?').get(tg);
const telegramUsers = () => db.prepare('SELECT * FROM users WHERE telegram_id IS NOT NULL').all();

/* ---------- tipos ---------- */
const listTypes = uid => db.prepare('SELECT id,name FROM types WHERE user_id=? ORDER BY name COLLATE NOCASE').all(uid);

function addType(uid, name) {
  name = String(name || '').trim();
  if (!name || name.length > 40) return { error: 'Nombre de tipo inválido (1-40 caracteres)' };
  try {
    return { id: Number(db.prepare('INSERT INTO types(user_id,name) VALUES(?,?)').run(uid, name).lastInsertRowid) };
  } catch { return { error: 'Ese tipo ya existe' }; }
}

function deleteType(uid, id, reassign) {
  const t = owned('types', uid, id);
  if (!t) return { error: 'Tipo no encontrado', status: 404 };
  if (t.name === DEFAULT_TYPE) return { error: `El tipo "${DEFAULT_TYPE}" es el tipo por defecto y no se puede eliminar` };
  const n = db.prepare('SELECT COUNT(*) c FROM movements WHERE type_id=?').get(id).c;
  return db.transaction(() => {
    if (n > 0) {
      if (!reassign) return { error: `El tipo tiene ${n} movimientos asociados. Indica otro tipo al que moverlos.`, status: 409, count: n };
      if (Number(reassign) === Number(id) || !owned('types', uid, reassign)) return { error: 'Tipo destino inválido' };
      db.prepare('UPDATE movements SET type_id=? WHERE type_id=?').run(reassign, id);
    }
    db.prepare('DELETE FROM types WHERE id=?').run(id);
    return { ok: true, moved: n };
  })();
}

/* ---------- cuentas ---------- */
function accountsWithBalance(uid) {
  return db.prepare(`
    SELECT a.*, COALESCE((SELECT SUM(amount) FROM movements m WHERE m.account_id=a.id),0) AS calculated
    FROM accounts a WHERE a.user_id=? ORDER BY a.active DESC, a.name COLLATE NOCASE`).all(uid)
    .map(a => ({ ...a, diff: a.real_balance - a.calculated }));
}

function addAccount(uid, name, joint, balance) {
  name = String(name || '').trim();
  if (!name || name.length > 40) return { error: 'Nombre de cuenta inválido (1-40 caracteres)' };
  const c = toCents(balance === '' || balance == null ? 0 : balance);
  if (c === null) return { error: 'Saldo inválido' };
  try {
    return db.transaction(() => {
      const id = Number(db.prepare('INSERT INTO accounts(user_id,name,joint,real_balance) VALUES(?,?,?,?)')
        .run(uid, name, joint ? 1 : 0, c).lastInsertRowid);
      if (c !== 0) {
        let t = db.prepare('SELECT id FROM types WHERE user_id=? AND name=?').get(uid, DEFAULT_TYPE);
        if (!t) t = { id: Number(db.prepare('INSERT INTO types(user_id,name) VALUES(?,?)').run(uid, DEFAULT_TYPE).lastInsertRowid) };
        db.prepare('INSERT INTO movements(user_id,type_id,account_id,description,amount,date,initial) VALUES(?,?,?,?,?,?,1)')
          .run(uid, t.id, id, 'situación inicial', c, nowStr());
      }
      return { id };
    })();
  } catch { return { error: 'Ya existe una cuenta con ese nombre' }; }
}

function setActive(uid, id, active) {
  if (!owned('accounts', uid, id)) return { error: 'Cuenta no encontrada', status: 404 };
  db.prepare('UPDATE accounts SET active=? WHERE id=?').run(active ? 1 : 0, id);
  return { ok: true };
}

function setRealBalance(uid, id, cents) {
  if (!owned('accounts', uid, id)) return { error: 'Cuenta no encontrada', status: 404 };
  if (cents === null) return { error: 'Importe inválido' };
  db.prepare('UPDATE accounts SET real_balance=? WHERE id=?').run(cents, id);
  const a = accountsWithBalance(uid).find(x => x.id === Number(id));
  return { ok: true, calculated: a.calculated, real: a.real_balance, diff: a.diff, name: a.name };
}

/* ---------- movimientos ---------- */
function addMovement(uid, m) {
  const type = owned('types', uid, m.type_id);
  const acc = owned('accounts', uid, m.account_id);
  if (!type) return { error: 'Tipo inválido' };
  if (!acc) return { error: 'Cuenta inválida' };
  if (!acc.active) return { error: 'La cuenta está desactivada' };
  const amount = typeof m.amount === 'number' ? m.amount : toCents(m.amount);
  if (amount === null || amount === 0) return { error: 'Importe inválido' };
  let rel = null;
  if (m.related_id !== undefined && m.related_id !== null && m.related_id !== '') {
    if (!owned('movements', uid, m.related_id)) return { error: 'El movimiento relacionado no existe' };
    rel = Number(m.related_id);
  }
  let date = m.date ? String(m.date).trim() : nowStr();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(date)) date += ':00';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(date)) return { error: 'Fecha inválida' };
  const id = db.prepare('INSERT INTO movements(user_id,type_id,account_id,description,amount,related_id,date) VALUES(?,?,?,?,?,?,?)')
    .run(uid, type.id, acc.id, String(m.description || '').trim().slice(0, 200), amount, rel, date).lastInsertRowid;
  return { id: Number(id), type: type.name, account: acc.name, amount, date };
}

function editMovement(uid, id, field, value) {
  if (!owned('movements', uid, id)) return { error: 'Movimiento no encontrado', status: 404 };
  let val;
  switch (field) {
    case 'amount':
      val = toCents(value);
      if (val === null || val === 0) return { error: 'Importe inválido' };
      break;
    case 'date': {
      let s = String(value || '').trim();
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) s += ':00';
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) return { error: 'Fecha inválida' };
      val = s; break;
    }
    case 'type_id':
      if (!owned('types', uid, value)) return { error: 'Tipo inválido' };
      val = Number(value); break;
    case 'account_id': {
      const a = owned('accounts', uid, value);
      if (!a) return { error: 'Cuenta inválida' };
      if (!a.active) return { error: 'La cuenta está desactivada' };
      val = Number(value); break;
    }
    case 'related_id':
      if (value === '' || value == null) val = null;
      else {
        if (Number(value) === Number(id) || !owned('movements', uid, value)) return { error: 'Movimiento relacionado inválido' };
        val = Number(value);
      }
      break;
    case 'description':
      val = String(value || '').trim().slice(0, 200); break;
    default: return { error: 'Campo no editable' };
  }
  db.prepare(`UPDATE movements SET ${field}=? WHERE id=?`).run(val, id);
  return { ok: true };
}

function deleteMovement(uid, id) {
  if (!owned('movements', uid, id)) return { error: 'Movimiento no encontrado', status: 404 };
  db.prepare('DELETE FROM movements WHERE id=?').run(id);
  return { ok: true };
}

function listMovements(uid, f = {}, limitDefault = 50) {
  const w = ['m.user_id=?'], p = [uid];
  if (f.from) { w.push('m.date>=?'); p.push(f.from.length === 10 ? f.from + 'T00:00:00' : f.from); }
  if (f.to) { w.push('m.date<=?'); p.push(f.to.length === 10 ? f.to + 'T23:59:59' : f.to); }
  if (f.type) { w.push('m.type_id=?'); p.push(Number(f.type)); }
  if (f.account) { w.push('m.account_id=?'); p.push(Number(f.account)); }
  if (f.q) { w.push('m.description LIKE ?'); p.push('%' + f.q + '%'); }
  const filtered = w.length > 1;
  const rows = db.prepare(`
    SELECT m.id,m.date,m.type_id,t.name AS type,m.account_id,a.name AS account,m.description,m.amount,m.related_id
    FROM movements m JOIN types t ON t.id=m.type_id JOIN accounts a ON a.id=m.account_id
    WHERE ${w.join(' AND ')} ORDER BY m.date DESC, m.id DESC ${filtered ? '' : 'LIMIT ' + limitDefault}`).all(...p);
  return { rows, filtered };
}

/* ---------- estadísticas ---------- */
// Evolución mensual del dinero total (acumulado). Por defecto solo cuentas individuales.
function evolution(uid, includeJoint = false) {
  const cond = includeJoint ? '' : 'AND a.joint=0';
  const rows = db.prepare(`SELECT substr(m.date,1,7) ym, SUM(m.amount) s FROM movements m JOIN accounts a ON a.id=m.account_id
    WHERE m.user_id=? ${cond} GROUP BY ym ORDER BY ym`).all(uid);
  if (!rows.length) return [];
  const map = new Map(rows.map(r => [r.ym, r.s]));
  const [y, mo] = rows[0].ym.split('-').map(Number);
  const now = new Date();
  const end = now.getFullYear() * 12 + now.getMonth();
  let cur = 0;
  const out = [];
  for (let i = y * 12 + mo - 1; i <= end; i++) {
    const ym = `${Math.floor(i / 12)}-${pad(i % 12 + 1)}`;
    cur += map.get(ym) || 0;
    out.push({ month: ym, total: cur });
  }
  return out;
}

// Neto por tipo en los últimos 4 meses + media mensual en el periodo elegido (0 = todo el histórico).
function typeStats(uid, months = 24) {
  const now = new Date();
  const labels = [];
  for (let i = 3; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    labels.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  }
  const from4 = labels[0] + '-01T00:00:00';
  let from, n;
  if (!months) {
    const first = db.prepare('SELECT MIN(date) d FROM movements WHERE user_id=?').get(uid).d;
    if (first) {
      const f = new Date(first);
      n = Math.max(1, (now.getFullYear() - f.getFullYear()) * 12 + now.getMonth() - f.getMonth() + 1);
      from = first;
    } else { n = 1; from = '0000'; }
  } else {
    from = fmtDate(new Date(now.getFullYear(), now.getMonth() - months, now.getDate()));
    n = months;
  }
  const per = db.prepare('SELECT type_id, substr(date,1,7) ym, SUM(amount) s FROM movements WHERE user_id=? AND date>=? AND initial=0 GROUP BY type_id, ym').all(uid, from4);
  const tot = db.prepare('SELECT type_id, SUM(amount) s FROM movements WHERE user_id=? AND date>=? AND initial=0 GROUP BY type_id').all(uid, from);
  const totMap = new Map(tot.map(r => [r.type_id, r.s]));
  const rows = listTypes(uid).map(t => ({
    type: t.name,
    values: labels.map(l => (per.find(r => r.type_id === t.id && r.ym === l) || { s: 0 }).s),
    avg: Math.round((totMap.get(t.id) || 0) / n)
  }));
  return { labels, rows, periodMonths: n };
}

/* ---------- exportación CSV ---------- */
// Solo movimientos, de más antiguo a más nuevo. Separador ";", decimales con coma, UTF-8 con BOM (abre bien en Excel).
function exportCsv(uid) {
  const rows = db.prepare(`SELECT m.id, t.name AS type, a.name AS account, m.date, m.amount, m.related_id
    FROM movements m JOIN types t ON t.id=m.type_id JOIN accounts a ON a.id=m.account_id
    WHERE m.user_id=? ORDER BY m.date ASC, m.id ASC`).all(uid);
  const q = v => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita inyección de fórmulas en Excel
    return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = ['ID;Tipo;Cuenta;Fecha;Importe;Relacion'].concat(rows.map(r =>
    [r.id, q(r.type), q(r.account), r.date.replace('T', ' '), (r.amount / 100).toFixed(2).replace('.', ','), r.related_id ?? ''].join(';')));
  return { count: rows.length, csv: '\uFEFF' + lines.join('\r\n') + '\r\n' };
}

/* ---------- informes de Telegram ---------- */
function dailyReport(uid) {
  const accs = accountsWithBalance(uid);
  const sum = j => accs.filter(a => a.joint === j).reduce((s, a) => s + a.calculated, 0);
  const d = new Date();
  const active = accs.filter(a => a.active);
  const hasJoint = accs.some(a => a.joint === 1); // si no hay cuentas conjuntas, no se hace ninguna distinción
  let t = `📊 Informe diario ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}\n\n` +
    `💰 Total${hasJoint ? ' personal' : ''}: ${eur(sum(0))}\n` +
    (hasJoint ? `🤝 Total en cuentas conjuntas: ${eur(sum(1))}\n` : '') + `\nCuentas:\n`;
  t += active.map(a => `• ${a.name}${a.joint ? ' (conjunta)' : ''}: ${eur(a.calculated)}${a.diff !== 0 ? ' !' : ''}`).join('\n') || '(sin cuentas activas)';
  if (active.some(a => a.diff !== 0)) t += '\n\n! = el saldo real indicado no coincide con el calculado';
  return t;
}

function monthlyReport(uid, ref = new Date()) {
  const s = new Date(ref.getFullYear(), ref.getMonth() - 1, 1);
  const e = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const S = fmtDate(s), E = fmtDate(e);
  const accs = accountsWithBalance(uid);
  const tot = j => accs.filter(a => a.joint === j).reduce((x, a) => x + a.calculated, 0);
  const delta = j => db.prepare(`SELECT COALESCE(SUM(m.amount),0) s FROM movements m JOIN accounts a ON a.id=m.account_id
    WHERE m.user_id=? AND m.date>=? AND m.date<? AND a.joint=? AND m.initial=0`).get(uid, S, E, j).s;
  const byType = db.prepare(`SELECT t.name n, SUM(m.amount) s FROM movements m JOIN types t ON t.id=m.type_id
    WHERE m.user_id=? AND m.date>=? AND m.date<? AND m.initial=0 GROUP BY t.id ORDER BY s`).all(uid, S, E);
  const byAcc = db.prepare(`SELECT a.name n, SUM(m.amount) s FROM movements m JOIN accounts a ON a.id=m.account_id
    WHERE m.user_id=? AND m.date>=? AND m.date<? AND m.initial=0 GROUP BY a.id ORDER BY s`).all(uid, S, E);
  const mes = s.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  const hasJoint = accs.some(a => a.joint === 1);
  const lbl = hasJoint ? ' (sin conjuntas)' : '';
  return `📅 Informe mensual: ${mes}\n\n` +
    `💰 Variación${lbl}: ${sg(delta(0))}\n💰 Total actual${lbl}: ${eur(tot(0))}\n\n` +
    (hasJoint ? `🤝 Variación cuentas conjuntas: ${sg(delta(1))}\n🤝 Total actual cuentas conjuntas: ${eur(tot(1))}\n\n` : '') +
    `Por tipo:\n${byType.map(r => `• ${r.n}: ${sg(r.s)}`).join('\n') || '(sin movimientos)'}\n\n` +
    `Por cuenta:\n${byAcc.map(r => `• ${r.n}: ${sg(r.s)}`).join('\n') || '(sin movimientos)'}`;
}

module.exports = {
  db, eur, sg, toCents, fmtDate,
  createUser, updateUser, changeOwnPassword, setReportPrefs, userByTelegram, telegramUsers,
  listTypes, addType, deleteType,
  accountsWithBalance, addAccount, setActive, setRealBalance,
  addMovement, editMovement, deleteMovement, listMovements,
  evolution, typeStats, exportCsv, dailyReport, monthlyReport
};
