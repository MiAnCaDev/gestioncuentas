const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');

const HELP = `🤖 Bot de control de gastos

⚙️ GENERALES
/cancelar – cancelar la operación en curso
/web – enlace a la web
/help – esta ayuda
/uso – guía de primeros pasos

💸 GASTOS E INGRESOS
/nuevo – añadir gasto/ingreso (negativo = gasto, positivo = ingreso)
/borrar – borrar un movimiento (doble confirmación)
/ultimos – ver los últimos 10 movimientos

🏦 CUENTAS
/nuevacuenta – crear una cuenta nueva
/activar – activar una cuenta desactivada
/desactivar – desactivar una cuenta

🏷️ TIPOS
/nuevotipo – crear un tipo nuevo
/tipos – ver tus tipos

📊 SALDOS
/saldos – saldo calculado de todas tus cuentas (! = no coincide con el saldo real)
/saldoreal – indicar el saldo real de una cuenta y ver la discrepancia

📥 EXPORTAR
/exportar – descargar tus gastos/ingresos en un fichero CSV

📅 Informes automáticos: recibirás por aquí un informe diario y otro mensual (resumen del mes anterior).`;

const USO = `📖 Cómo empezar

Cuando empieces a usar el sistema, sigue estos pasos:

1️⃣ Crea una cuenta donde asociarás tus gastos e ingresos (ej.: Santander, BBVA, Efectivo).
   👉 /nuevacuenta

2️⃣ Crea distintos tipos para categorizar esos gastos (ej.: Sueldo, Comida, Restaurante, Mercancía, Transporte, Diversión...). Ya tienes algunos por defecto; puedes verlos con /tipos.
   👉 /nuevotipo

3️⃣ Añade los gastos e ingresos que desees: el importe es negativo para un gasto y positivo para un ingreso.
   👉 /nuevo

💡 Para comprobar que todo cuadra, indica de vez en cuando el saldo real de tus cuentas con /saldoreal; el bot te avisará si hay discrepancias con lo calculado.

🌐 Todo esto se puede hacer tanto desde Telegram como desde la web (/web).`;

const WEB_URL = process.env.WEB_URL || 'https://gestioncuentas.mianca.com.es';
const chunk = (a, n) => a.reduce((r, x, i) => (i % n ? r[r.length - 1].push(x) : r.push([x]), r), []);

module.exports = function startBot(core) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.log('TELEGRAM_BOT_TOKEN vacío: el bot no se inicia.'); return null; }

  const bot = new Telegraf(token);
  const state = new Map(); // telegram_id -> { step, ... }
  const clear = ctx => ctx.editMessageReplyMarkup(undefined).catch(() => {});

  /* solo usuarios registrados */
  bot.use(async (ctx, next) => {
    if (!ctx.from) return;
    const u = core.userByTelegram(ctx.from.id);
    if (!u) {
      if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
      return ctx.reply(`⛔ No tienes permisos para usar este bot.\n\nPuedes solicitar el registro y obtener más información en el bot @TwiBlog_bot escribiendo el comando /contacto\n\nTu ID de Telegram es: ${ctx.from.id}`);
    }
    ctx.user = u;
    return next();
  });

  bot.command(['start', 'help'], ctx => ctx.reply(HELP));
  bot.command('uso', ctx => ctx.reply(USO));
  bot.command('web', ctx => ctx.reply('🌐 Acceso a la web:', Markup.inlineKeyboard([[Markup.button.url('Abrir ' + WEB_URL.replace(/^https?:\/\//, ''), WEB_URL)]])));
  bot.command('cancelar', ctx => { state.delete(ctx.from.id); ctx.reply('Operación cancelada.'); });

  /* ---- añadir movimiento ---- */
  bot.command('nuevo', ctx => {
    const types = core.listTypes(ctx.user.id);
    const accs = core.accountsWithBalance(ctx.user.id).filter(a => a.active);
    if (!types.length || !accs.length) return ctx.reply('Necesitas al menos un tipo y una cuenta activa (créalos con /nuevotipo y /nuevacuenta).');
    state.set(ctx.from.id, { step: 'type' });
    ctx.reply('Elige el tipo:', Markup.inlineKeyboard(chunk(types.map(t => Markup.button.callback(t.name, 'nt:' + t.id)), 2)));
  });

  bot.action(/^nt:(\d+)$/, async ctx => {
    await ctx.answerCbQuery(); clear(ctx);
    const s = state.get(ctx.from.id);
    if (!s || s.step !== 'type') return ctx.reply('Selección caducada. Usa /nuevo.');
    s.type_id = Number(ctx.match[1]); s.step = 'account';
    const accs = core.accountsWithBalance(ctx.user.id).filter(a => a.active);
    ctx.reply('Elige la cuenta:', Markup.inlineKeyboard(chunk(accs.map(a => Markup.button.callback(a.name, 'na:' + a.id)), 2)));
  });

  bot.action(/^na:(\d+)$/, async ctx => {
    await ctx.answerCbQuery(); clear(ctx);
    const s = state.get(ctx.from.id);
    if (!s || s.step !== 'account') return ctx.reply('Selección caducada. Usa /nuevo.');
    s.account_id = Number(ctx.match[1]); s.step = 'amount';
    ctx.reply('Escribe el importe (negativo = gasto, positivo = ingreso). Ej: -12,50');
  });

  /* ---- listar ---- */
  bot.command('ultimos', ctx => {
    const { rows } = core.listMovements(ctx.user.id, {}, 10);
    ctx.reply(rows.length ? rows.map(r => `#${r.id} ${r.date.slice(0, 16).replace('T', ' ')} · ${r.type} · ${r.account} · ${core.eur(r.amount)}${r.description ? ' · ' + r.description : ''}`).join('\n') : 'No hay movimientos.');
  });

  bot.command('tipos', ctx => ctx.reply('Tus tipos:\n' + (core.listTypes(ctx.user.id).map(t => '• ' + t.name).join('\n') || '(ninguno)')));

  bot.command('saldos', ctx => {
    const accs = core.accountsWithBalance(ctx.user.id);
    if (!accs.length) return ctx.reply('No tienes cuentas.');
    let t = '💳 Saldos (calculados con tus movimientos):\n' + accs.map(a =>
      `• ${a.name}${a.joint ? ' (conjunta)' : ''}${a.active ? '' : ' [inactiva]'}: ${core.eur(a.calculated)}${a.diff !== 0 ? ' !' : ''}`).join('\n');
    if (accs.some(a => a.diff !== 0)) t += '\n\n! = no coincide con el saldo real indicado';
    ctx.reply(t);
  });

  /* ---- borrar (doble confirmación) ---- */
  bot.command('borrar', ctx => {
    const { rows } = core.listMovements(ctx.user.id, {}, 10);
    if (!rows.length) return ctx.reply('No hay movimientos.');
    ctx.reply('¿Cuál quieres borrar?', Markup.inlineKeyboard(rows.map(r =>
      [Markup.button.callback(`#${r.id} ${r.date.slice(5, 10)} ${core.eur(r.amount)} ${r.description}`.slice(0, 60), 'd1:' + r.id)])));
  });
  bot.action(/^d1:(\d+)$/, async ctx => {
    await ctx.answerCbQuery(); clear(ctx);
    const id = ctx.match[1];
    ctx.reply(`¿Seguro que quieres borrar el movimiento #${id}?`, Markup.inlineKeyboard([[Markup.button.callback('Sí', 'd2:' + id), Markup.button.callback('No', 'dn')]]));
  });
  bot.action(/^d2:(\d+)$/, async ctx => {
    await ctx.answerCbQuery(); clear(ctx);
    const id = ctx.match[1];
    ctx.reply(`⚠️ Última confirmación: se borrará #${id} definitivamente.`, Markup.inlineKeyboard([[Markup.button.callback('🗑 Borrar definitivamente', 'dx:' + id), Markup.button.callback('Cancelar', 'dn')]]));
  });
  bot.action(/^dx:(\d+)$/, async ctx => {
    await ctx.answerCbQuery(); clear(ctx);
    const r = core.deleteMovement(ctx.user.id, Number(ctx.match[1]));
    ctx.reply(r.error ? '❌ ' + r.error : '✅ Movimiento borrado.');
  });
  bot.action('dn', async ctx => { await ctx.answerCbQuery(); clear(ctx); ctx.reply('Cancelado, no se ha borrado nada.'); });

  /* ---- saldo real ---- */
  bot.command('saldoreal', ctx => {
    const accs = core.accountsWithBalance(ctx.user.id);
    if (!accs.length) return ctx.reply('No tienes cuentas.');
    ctx.reply('¿De qué cuenta quieres indicar el saldo real?', Markup.inlineKeyboard(chunk(accs.map(a => Markup.button.callback(a.name, 'rb:' + a.id)), 2)));
  });
  bot.action(/^rb:(\d+)$/, async ctx => {
    await ctx.answerCbQuery(); clear(ctx);
    state.set(ctx.from.id, { step: 'real', account_id: Number(ctx.match[1]) });
    ctx.reply('Escribe el saldo real que aparece en la cuenta (ej: 1234,56):');
  });

  /* ---- activar / desactivar ---- */
  const toggleCmd = (name, active, prefix, msg) => bot.command(name, ctx => {
    const accs = core.accountsWithBalance(ctx.user.id).filter(a => !!a.active === !active);
    if (!accs.length) return ctx.reply('No hay cuentas para ' + name.slice(0, -1) + 'r.');
    ctx.reply(msg, Markup.inlineKeyboard(chunk(accs.map(a => Markup.button.callback(a.name, prefix + a.id)), 2)));
  });
  toggleCmd('activar', true, 'on:', 'Cuenta a activar:');
  toggleCmd('desactivar', false, 'off:', 'Cuenta a desactivar:');
  bot.action(/^(on|off):(\d+)$/, async ctx => {
    await ctx.answerCbQuery(); clear(ctx);
    const r = core.setActive(ctx.user.id, Number(ctx.match[2]), ctx.match[1] === 'on');
    ctx.reply(r.error ? '❌ ' + r.error : ctx.match[1] === 'on' ? '✅ Cuenta activada.' : '✅ Cuenta desactivada.');
  });

  /* ---- exportar CSV ---- */
  bot.command('exportar', ctx => {
    const { csv, count } = core.exportCsv(ctx.user.id);
    if (!count) return ctx.reply('No hay movimientos que exportar.');
    return ctx.replyWithDocument(
      { source: Buffer.from(csv, 'utf8'), filename: `gastos_${core.fmtDate(new Date()).slice(0, 10)}.csv` },
      { caption: `📥 ${count} movimientos, de más antiguo a más nuevo.` });
  });

  /* ---- nueva cuenta ---- */
  bot.command('nuevacuenta', ctx => {
    const name = ctx.message.text.split(/\s+/).slice(1).join(' ');
    if (name) return askJoint(ctx, name);
    state.set(ctx.from.id, { step: 'accname' });
    ctx.reply('Escribe el nombre de la nueva cuenta (ej: Santander, Efectivo):');
  });
  function askJoint(ctx, name) {
    if (name.length > 40) return ctx.reply('El nombre es demasiado largo (máximo 40 caracteres). Inténtalo de nuevo:');
    state.set(ctx.from.id, { step: 'accjoint', name });
    return ctx.reply(`Cuenta "${name}". ¿Es individual o conjunta (compartida con otras personas)?`,
      Markup.inlineKeyboard([[Markup.button.callback('Individual', 'aj:0'), Markup.button.callback('Conjunta', 'aj:1')]]));
  }
  bot.action(/^aj:([01])$/, async ctx => {
    await ctx.answerCbQuery(); clear(ctx);
    const s = state.get(ctx.from.id);
    if (!s || s.step !== 'accjoint') return ctx.reply('Selección caducada. Usa /nuevacuenta.');
    s.joint = ctx.match[1] === '1'; s.step = 'accbal';
    ctx.reply('¿Qué saldo tiene actualmente? (puede ser 0, ej: 1234,56)');
  });

  /* ---- nuevo tipo ---- */
  bot.command('nuevotipo', ctx => {
    const name = ctx.message.text.split(/\s+/).slice(1).join(' ');
    if (name) { const r = core.addType(ctx.user.id, name); return ctx.reply(r.error ? '❌ ' + r.error : `✅ Tipo "${name}" creado.`); }
    state.set(ctx.from.id, { step: 'newtype' });
    ctx.reply('Escribe el nombre del nuevo tipo:');
  });

  /* ---- texto libre según el paso ---- */
  bot.on('text', async ctx => {
    const s = state.get(ctx.from.id), t = ctx.message.text.trim();
    if (!s) return ctx.reply('No te he entendido. Usa /help para ver los comandos.');
    if (s.step === 'amount') {
      const c = core.toCents(t);
      if (c === null || c === 0) return ctx.reply('Importe no válido. Ejemplos: -12,50 o 100');
      s.amount = c; s.step = 'desc';
      return ctx.reply('Escribe una breve descripción:');
    }
    if (s.step === 'desc') {
      state.delete(ctx.from.id);
      const r = core.addMovement(ctx.user.id, { type_id: s.type_id, account_id: s.account_id, amount: s.amount, description: t });
      return ctx.reply(r.error ? '❌ ' + r.error : `✅ Guardado #${r.id}: ${core.eur(r.amount)} · ${r.type} · ${r.account} · ${t}`);
    }
    if (s.step === 'real') {
      const c = core.toCents(t);
      if (c === null) return ctx.reply('Importe no válido. Ejemplo: 1234,56');
      state.delete(ctx.from.id);
      const r = core.setRealBalance(ctx.user.id, s.account_id, c);
      if (r.error) return ctx.reply('❌ ' + r.error);
      return ctx.reply(r.diff === 0
        ? `✅ En ${r.name} coinciden el saldo calculado y el real (${core.eur(r.calculated)}).`
        : `⚠️ Discrepancia en ${r.name}\nCalculado: ${core.eur(r.calculated)}\nReal: ${core.eur(r.real)}\nDiferencia (real − calculado): ${core.sg(r.diff)}`);
    }
    if (s.step === 'accname') {
      if (!t) return ctx.reply('Escribe un nombre válido:');
      return askJoint(ctx, t);
    }
    if (s.step === 'accbal') {
      const c = core.toCents(t);
      if (c === null) return ctx.reply('Importe no válido. Ejemplos: 0 o 1234,56');
      state.delete(ctx.from.id);
      const r = core.addAccount(ctx.user.id, s.name, s.joint, t);
      return ctx.reply(r.error ? '❌ ' + r.error
        : `✅ Cuenta "${s.name}" creada (${s.joint ? 'conjunta' : 'individual'}) con saldo ${core.eur(c)}.` +
          (c !== 0 ? '\nSe ha registrado un movimiento "situación inicial" en el tipo Otros.' : ''));
    }
    if (s.step === 'newtype') {
      state.delete(ctx.from.id);
      const r = core.addType(ctx.user.id, t);
      return ctx.reply(r.error ? '❌ ' + r.error : `✅ Tipo "${t}" creado.`);
    }
    ctx.reply('Usa los botones de arriba o /cancelar.');
  });

  bot.catch((err, ctx) => { console.error('Bot error:', err); ctx.reply('❌ Ha ocurrido un error.').catch(() => {}); });

  /* ---- informes programados ---- */
  const tz = process.env.TZ || 'Europe/Madrid';
  const broadcast = fn => core.telegramUsers().forEach(u =>
    bot.telegram.sendMessage(u.telegram_id, fn(u.id)).catch(e => console.error('Envío fallido a', u.username, e.message)));
  // Horarios configurables por variables de entorno (formato cron de 5 campos); por defecto 9:00.
  const schedule = (name, def) => {
    const v = (process.env[name] || def).trim();
    if (cron.validate(v)) return v;
    console.error(`${name} no es una expresión cron válida ("${v}"); se usa "${def}".`);
    return def;
  };
  const dailyCron = schedule('DAILY_REPORT_CRON', '0 9 * * *');
  const monthlyCron = schedule('MONTHLY_REPORT_CRON', '0 9 1 * *');
  cron.schedule(dailyCron, () => broadcast(core.dailyReport), { timezone: tz });
  cron.schedule(monthlyCron, () => broadcast(core.monthlyReport), { timezone: tz });
  console.log(`Informes programados (${tz}): diario "${dailyCron}", mensual "${monthlyCron}"`);

  bot.telegram.setMyCommands([
    { command: 'cancelar', description: 'Cancelar la operación en curso' },
    { command: 'web', description: 'Enlace a la web' },
    { command: 'help', description: 'Ayuda' },
    { command: 'uso', description: 'Guía de primeros pasos' },
    { command: 'nuevo', description: 'Añadir gasto/ingreso' },
    { command: 'borrar', description: 'Borrar un movimiento' },
    { command: 'ultimos', description: 'Últimos movimientos' },
    { command: 'nuevacuenta', description: 'Crear cuenta' },
    { command: 'activar', description: 'Activar cuenta' },
    { command: 'desactivar', description: 'Desactivar cuenta' },
    { command: 'nuevotipo', description: 'Crear tipo' },
    { command: 'tipos', description: 'Ver tipos' },
    { command: 'saldos', description: 'Saldos de las cuentas' },
    { command: 'saldoreal', description: 'Indicar saldo real de una cuenta' },
    { command: 'exportar', description: 'Descargar gastos/ingresos en CSV' }
  ]).catch(() => {});

  bot.launch().catch(e => console.error('No se pudo iniciar el bot:', e.message));
  console.log('Bot de Telegram iniciado.');
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
  process.once('SIGINT', () => bot.stop('SIGINT'));
  return bot;
};
