# Control de gastos personal (web + bot de Telegram)

Un único contenedor Docker con:

- **Web** (Express) para registrar gastos/ingresos, gestionar cuentas y tipos, ver gráficas y estadísticas.
- **Bot de Telegram** (Telegraf) para hacer lo mismo desde el móvil.
- **Informes automáticos** por Telegram: diario (9:00) y mensual (día 1 a las 9:00), con horario configurable.
- **Base de datos SQLite** en un único fichero (`./data/gastos.db`), sin necesidad de MySQL.

## Puesta en marcha

1. Crea el bot en Telegram: habla con [@BotFather](https://t.me/BotFather), envía `/newbot` y guarda el **token**.
2. Copia la configuración y edítala:
   ```bash
   cp .env.example .env
   nano .env
   ```
   | Variable | Descripción |
   |---|---|
   | `ADMIN_USER` / `ADMIN_PASSWORD` | Administrador inicial (solo se crea si la BD está vacía; la contraseña debe cumplir la política de contraseñas, ver más abajo). |
   | `ADMIN_TELEGRAM_ID` | (Opcional) tu ID de Telegram, para usar el bot desde el primer momento. |
   | `TELEGRAM_BOT_TOKEN` | Token de BotFather. Vacío = el bot no arranca (la web sí). |
   | `DAILY_REPORT_CRON` / `MONTHLY_REPORT_CRON` | Cuándo se envían los informes (ver «Informes programados»). Por defecto `0 9 * * *` y `0 9 1 * *`. |
   | `TZ` | Zona horaria (fechas por defecto e informes programados). Por defecto `Europe/Madrid`. |
   | `COOKIE_SECURE` | `true` (se accede por HTTPS a través de Cloudflare). |
   | `WEB_URL` / `BOT_URL` | Enlaces que muestra el bot (`/web`). Por defecto `https://gestioncuentas.mianca.com.es` y `https://t.me/gestioncuentas_bot`. |
3. Arranca:
   ```bash
   docker compose up -d --build
   docker compose logs -f
   ```
4. Abre `http://localhost:8234` (o `https://gestioncuentas.mianca.com.es` si ya tienes el túnel) e inicia sesión con el administrador.

> No tengas dos instancias del bot con el mismo token a la vez (por ejemplo, el bot antiguo en PHP): Telegram solo permite una.

## Usuarios y acceso

- Solo el **administrador** puede registrar usuarios (botón *Usuarios* en la web): usuario, contraseña e **ID de Telegram**.
- Si alguien no registrado escribe al bot, recibe un mensaje de "sin permisos" que le indica que puede solicitar el registro y más información en el bot **@TwiBlog_bot** con el comando `/contacto`, e incluye su ID de Telegram para que puedas registrarlo. En la web, solo pueden entrar usuarios registrados.
- **Política de contraseñas:** entre 8 y 64 caracteres, con al menos una mayúscula, una minúscula y un número. Se admiten símbolos habituales, pero no espacios ni caracteres raros (solo ASCII imprimible). Se aplica al crear usuarios, al cambiar contraseñas y al restablecerlas; las contraseñas ya existentes siguen siendo válidas.
- **Modo claro/oscuro:** botón en el menú del usuario (☰), justo antes de *Salir*. La elección se guarda en la cuenta del usuario (no en el navegador), por lo que se mantiene al iniciar sesión desde otro navegador o dispositivo. Mientras el usuario no lo cambie, se sigue el tema del sistema.
- **Informes:** en *Perfil* cada usuario puede activar o desactivar por separado el informe diario y el mensual (por defecto ambos activados).
- **Perfil:** desde el menú del usuario (☰ con su nombre, arriba a la derecha) cada usuario ve su usuario y su ID de Telegram y puede cambiar su contraseña (pide la actual y la nueva dos veces; al cambiarla se cierran sus otras sesiones). El ID de Telegram solo lo cambia el administrador.
- Cada usuario ve únicamente sus propios datos (movimientos, cuentas, tipos). Los nuevos usuarios reciben unos tipos por defecto (Comida, Transporte, Diversión, Mercancía, Otros). **«Otros» es el tipo por defecto de todos los usuarios y no se puede eliminar** (se usa para la «situación inicial» de las cuentas).

## Funcionamiento

### Movimientos
Campos: `id`, tipo, cuenta, descripción, importe, relación (ID de otro movimiento) y fecha (por defecto ahora). **Importe positivo = ingreso, negativo = gasto.** Todo se guarda en céntimos (enteros) y se muestra con dos decimales.

Ejemplo de **relación**: pagas una cena de 200 € en efectivo (id 57) y tres amigos te hacen Bizum de 50 € a Santander: crea los tres ingresos con "Relacionado con ID" = 57.

### Cuentas
- Nombre, **individual/conjunta**, **activa/inactiva** y **saldo real**.
- Una cuenta inactiva no admite nuevos movimientos pero conserva el histórico y puede reactivarse.
- **Saldo calculado** = suma de los movimientos de la cuenta (parte siempre de 0).
- Al crear una cuenta con un saldo distinto de 0 se inserta automáticamente un movimiento con descripción **«situación inicial»** y tipo **«Otros»** por ese importe, y ese mismo valor queda como saldo real. Se puede editar o borrar como cualquier otro movimiento. Estos movimientos cuentan en los totales y en la gráfica, pero no se consideran gasto/ingreso en el informe mensual (variaciones, por tipo y por cuenta) ni en las estadísticas por tipo.
- **Discrepancia** = saldo real − saldo calculado. Si es distinta de 0 se avisa (`!` en el bot, importe en la web; ✔️ si coincide).
- Las cuentas conjuntas se excluyen del "dinero total personal", pero las gestiona íntegramente el usuario.

### Web
- Gráfica de evolución mensual del dinero total (solo individuales; casilla para incluir conjuntas).
- Listado de los últimos 50 movimientos; con filtros (fechas, tipo, cuenta, descripción con LIKE) muestra todos los resultados.
- Edición en línea con doble clic (o pulsación larga en móvil); Enter o perder el foco termina la edición y pide confirmación.
- Popup *Cuentas y saldos*: crear cuentas, activar/desactivar, saldo real vs. calculado.
- Popup *Gastos por tipo*: neto de los últimos 4 meses + media mensual configurable (6 meses, 1–5 años o total). Por defecto 2 años. La media es el neto del periodo dividido entre el nº de meses.
- Popup *Tipos*: crear y eliminar. Si el tipo tiene movimientos, se pide moverlos a otro tipo existente antes de borrar.
- Menú de usuario (☰ con el nombre): **Perfil**, enlace al **bot** ([t.me/gestioncuentas_bot](https://t.me/gestioncuentas_bot)), **ayuda** (❓) y **salir**. El botón *Usuarios* sigue en la barra superior para el administrador.

### Bot
| Grupo | Comando | Acción |
|---|---|---|
| ⚙️ Generales | `/cancelar` | Cancelar la operación en curso. |
| | `/web` | Enlace a la web. |
| | `/help` | Ayuda con todos los comandos, agrupados. |
| | `/uso` | Guía de primeros pasos: crear cuenta → crear tipos → añadir gastos. |
| 💸 Gastos | `/nuevo` | Añadir movimiento: tipo → cuenta → importe → descripción (fecha = ahora). |
| | `/borrar` | Elegir un movimiento y confirmar **dos veces**. |
| | `/ultimos` | Últimos 10 movimientos. |
| 🏦 Cuentas | `/nuevacuenta [nombre]` | Crear una cuenta: nombre → individual/conjunta → saldo actual (puede ser 0). Si el saldo no es 0 se registra la «situación inicial». |
| | `/activar`, `/desactivar` | Activar/desactivar cuentas. |
| 🏷️ Tipos | `/nuevotipo [nombre]` | Crear un tipo. |
| | `/tipos` | Listar tipos. |
| 📊 Saldos | `/saldos` | Saldo calculado de cada cuenta (`!` si no coincide con el real). |
| | `/saldoreal` | Indicar el saldo real de una cuenta y ver la discrepancia. |
| 📥 Exportar | `/exportar` | Recibir un CSV con todos tus gastos/ingresos. |

**Informe diario (9:00 por defecto):** total personal, total en conjuntas y saldo de cada cuenta activa (con `!` si hay discrepancia).
**Informe mensual (día 1, 9:00 por defecto):** variación y total actual (sin conjuntas), variación y total en conjuntas, y neto del mes anterior por tipo y por cuenta.

## Informes programados (horario y día de ejecución)

El propio contenedor envía por Telegram dos informes a cada usuario que tenga un ID de Telegram registrado:

| Informe | Variable | Valor por defecto | Significado |
|---|---|---|---|
| Diario | `DAILY_REPORT_CRON` | `0 9 * * *` | todos los días a las 9:00 |
| Mensual | `MONTHLY_REPORT_CRON` | `0 9 1 * *` | el día 1 de cada mes a las 9:00 (resumen del mes anterior) |

Los valores usan el formato **cron de 5 campos**:

```
┌───────── minuto (0-59)
│ ┌─────── hora (0-23)
│ │ ┌───── día del mes (1-31)
│ │ │ ┌─── mes (1-12)
│ │ │ │ ┌─ día de la semana (0-7; 0 y 7 = domingo)
│ │ │ │ │
0 9 * * *
```

Ejemplos:

| Quiero… | Valor |
|---|---|
| Informe diario a las 8:30 | `DAILY_REPORT_CRON=30 8 * * *` |
| Informe diario a las 21:00 | `DAILY_REPORT_CRON=0 21 * * *` |
| Informe diario solo de lunes a viernes | `DAILY_REPORT_CRON=0 9 * * 1-5` |
| Informe mensual el día 5 a las 10:00 | `MONTHLY_REPORT_CRON=0 10 5 * *` |
| Informe mensual el día 1 a las 7:30 | `MONTHLY_REPORT_CRON=30 7 1 * *` |

Cómo cambiarlo:
1. Edita `.env` y modifica (o añade) las variables.
2. Aplica el cambio recreando el contenedor: `docker compose up -d` (un simple `docker compose restart` **no** relee el `.env`).
3. Comprueba en `docker compose logs` la línea `Informes programados (Europe/Madrid): diario "...", mensual "..."`.

Notas:
- La hora se interpreta en la zona horaria `TZ` del `.env`.
- El informe mensual siempre resume el **mes natural anterior** a la fecha de envío, tengas el día que tengas configurado.
- Si la expresión no es válida, se registra un error en los logs y se usa el valor por defecto.
- Si el contenedor está parado a la hora programada, ese informe no se envía (no hay recuperación posterior).
- Para probar, pon temporalmente `DAILY_REPORT_CRON=* * * * *` (se envía cada minuto), comprueba que te llega y vuelve a dejar el valor normal.
- Solo reciben informes los usuarios con ID de Telegram asignado y solo si `TELEGRAM_BOT_TOKEN` está configurado.
- Cada usuario puede desactivar el informe diario y/o el mensual desde su *Perfil* en la web (menú ☰ → Perfil → «Informes por Telegram»). Por defecto están activados.
- Si prefieres fijarlo en el código, está en `src/bot.js` (valores por defecto de `schedule(...)`); después reconstruye con `docker compose up -d --build`.

## Informes: cuentas conjuntas
Si el usuario no tiene ninguna cuenta conjunta, los informes (diario y mensual) no distinguen entre personal y conjunto: no aparece ninguna línea de cuentas conjuntas y el total se muestra simplemente como «Total».

## Exportar a CSV
- **Web:** menú del usuario (☰) → *📥 Descargar CSV*, justo debajo de *Perfil*. **Bot:** `/exportar`.
- Contiene solo los gastos/ingresos (incluidas las «situación inicial»), ordenados del más antiguo al más nuevo, con las columnas `ID;Tipo;Cuenta;Fecha;Importe;Relacion`.
- Formato: separador `;`, importes con coma decimal y dos decimales, fecha `AAAA-MM-DD HH:MM:SS`, codificación UTF-8 con BOM (se abre correctamente en Excel en español).

## Copias de seguridad y mantenimiento

Todo el estado está en `./data/gastos.db`.
```bash
# copia en caliente (recomendado)
docker compose exec gastos node -e "require('better-sqlite3')('/data/gastos.db').backup('/data/backup.db').then(()=>console.log('ok'))"
# o simplemente detén el contenedor y copia ./data
```
Actualizar tras cambios en el código: `docker compose up -d --build`.

## Cloudflare Tunnel y puerto

El contenedor publica la web **solo en `127.0.0.1:8234`** (puerto interno 3000). En Cloudflare Zero Trust, en la *Published application route* del túnel:

| Hostname | Servicio |
|---|---|
| `gestioncuentas.mianca.com.es` | `http://localhost:8234` |

Si cambias el puerto en el túnel, cambia también el mapeo `127.0.0.1:8234:3000` de `docker-compose.yml`. Si `cloudflared` corre en otro contenedor o máquina, quita `127.0.0.1:` o usa una red Docker compartida y apunta a `http://gastos:3000`.

## Indexación

La web **no es indexable**: `robots.txt` con `Disallow: /`, etiqueta `<meta name="robots" content="noindex…">` y cabecera HTTP `X-Robots-Tag: noindex, nofollow…` en todas las respuestas. (El robots.txt solo "pide" a los bots que no entren; el acceso real está protegido por el login.)

## Estructura
```
src/db.js      esquema SQLite y toda la lógica (usuarios, cuentas, movimientos, informes)
src/server.js  web + API REST + sesiones
src/bot.js     bot de Telegram + tareas programadas
public/        interfaz web (index.html)
```

## Problemas habituales
- **El bot no responde:** revisa `docker compose logs` y que `TELEGRAM_BOT_TOKEN` sea correcto y no esté en uso por otra instancia.
- **"Sin permisos" en el bot:** el ID de Telegram del usuario no está registrado (o está mal) en *Usuarios*.
- **Informes a otra hora:** ajusta `TZ`.
- **Gráfica vacía:** se carga Chart.js desde un CDN; si el servidor no tiene Internet en el navegador del cliente, descárgalo y sírvelo desde `public/`.
