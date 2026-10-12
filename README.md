# Control de gastos personal (web + bot de Telegram)

Un único contenedor Docker con:

- **Web** (Express) para registrar gastos/ingresos, gestionar cuentas y tipos, ver gráficas y estadísticas.
- **Bot de Telegram** (Telegraf) para hacer lo mismo desde el móvil.
- **Informes automáticos** por Telegram: diario (9:00) y mensual (día 1 a las 9:00).
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
   | `ADMIN_USER` / `ADMIN_PASSWORD` | Administrador inicial (solo se crea si la BD está vacía; contraseña ≥ 8 caracteres). |
   | `ADMIN_TELEGRAM_ID` | (Opcional) tu ID de Telegram, para usar el bot desde el primer momento. |
   | `TELEGRAM_BOT_TOKEN` | Token de BotFather. Vacío = el bot no arranca (la web sí). |
   | `TZ` | Zona horaria (fechas por defecto e informes de las 9:00). Por defecto `Europe/Madrid`. |
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
- Icono ❓ con la ayuda y botón 🤖 con enlace al bot ([t.me/gestioncuentas_bot](https://t.me/gestioncuentas_bot)).

### Bot
| Comando | Acción |
|---|---|
| `/nuevo` | Añadir movimiento: tipo → cuenta → importe → descripción (fecha = ahora). |
| `/borrar` | Elegir un movimiento y confirmar **dos veces**. |
| `/ultimos` | Últimos 10 movimientos. |
| `/saldos` | Saldo calculado de cada cuenta (`!` si no coincide con el real). |
| `/saldoreal` | Indicar el saldo real de una cuenta y ver la discrepancia. |
| `/activar`, `/desactivar` | Activar/desactivar cuentas. |
| `/nuevotipo [nombre]` | Crear un tipo. |
| `/tipos` | Listar tipos. |
| `/cancelar` | Cancelar la operación en curso. |
| `/web` | Enlace a la web. |
| `/help` | Ayuda. |

**Informe diario (9:00):** total personal, total en conjuntas y saldo de cada cuenta activa (con `!` si hay discrepancia).
**Informe mensual (día 1, 9:00):** variación y total actual (sin conjuntas), variación y total en conjuntas, y neto del mes anterior por tipo y por cuenta.

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
