# Flota de agentes SEO/GEO para Yume (piloto)

Estado: **construido y corriendo en Yume** (2026-10-26). Ver sección 10. Primer sitio: studioyume.mx. Luego se replica a Luvory, Dizayn, etc. cambiando solo la config del sitio.

## 1. Objetivo

Agentes que trabajen solos por calendario (no solo reporten lo que ya sabemos) en cuatro frentes:

1. **Analista**: vigila GSC, Bing y analytics. Qué funciona, qué no, posiciones, páginas, indexación.
2. **Fixer**: arregla los problemas de ranking que ya tenemos.
3. **Investigador de temas**: busca temas SEO y GEO que aún no cubrimos.
4. **Redactor**: prepara y publica 2 posts por semana, lunes y miércoles.

Todo se controla y supervisa desde el SEO-Watchdog (dashboard, pausa, aprobaciones, costo).

## 2. Decisiones ya tomadas

| # | Decisión |
|---|----------|
| Motor | **Solo Claude**. Nada de Codex por ahora. Codex queda como mejora futura si el cupo no alcanza. |
| Cuenta | **Suscripción** (login `claude.ai`), **no** la API de Anthropic. Ver sección 4. |
| Dónde corre | En la Raspberry Pi, bajo pm2, con `nice -n 19`, un agente a la vez. |
| Control | Se amplía el Watchdog: tablas `jobs`, `runs`, `approvals`, scheduler interno, pestaña "Agentes". |
| Posts | Borrador listo, **tú aprobás en el dashboard** antes de publicar. 4 semanas así; luego se evalúa pasar a publicación automática con checklist. |
| Fixer | Aplica solo cambios de bajo riesgo (títulos, metas, alt, FAQ, schema). Todo lo demás pide aprobación. Un commit por cambio, push inmediato. |
| Avisos | Telegram (el código ya existe en el Watchdog). Se aprueba desde el dashboard. |
| Bing | Arrancar solo con GSC. Luego sumar la API de Bing Webmaster (clave gratis que crea el dueño). |
| Tokens | Medir una semana real y decidir después. Cada corrida registra su uso. |

## 3. Agentes

Cada agente es un job que lanza `claude -p` con un prompt fijo, herramientas permitidas explícitas y un directorio de trabajo acotado. El orquestador es **código** (el scheduler del Watchdog), no un LLM: no gasta tokens en decidir cuándo correr.

| Agente | Cuándo | Lee | Escribe | Autonomía |
|---|---|---|---|---|
| **Analista** | Diario 06:30 | GSC (`scripts/gsc_query.py`/`src/gsc.ts`), Clarity, crawl del Watchdog, luego Bing | tabla `metrics`, `findings`, resumen del día | Solo lectura |
| **Investigador** | Domingo 18:00 | Queries de GSC con impresiones y posición 8-30, Trends (`trends_query.py`), Serper, `src/gaps.ts`, `blog.ts` (anti-canibalización) | tabla `topics` (backlog priorizado, con razón y evidencia) | Solo lectura |
| **Redactor** | Domingo 20:00 y martes 20:00 (borrador para lunes y miércoles) | `topics`, `blog.ts`, `blog.en.ts`, `BLOG_SLUG_EN`, playbooks | rama `post/<slug>` en un worktree, fila en `approvals` | Borrador + aprobación |
| **Fixer** | Diario 07:30, sobre `findings` nuevos | `findings`, repo Yume | commits en worktree; low-risk se empujan; el resto va a `approvals` | Bajo riesgo auto, resto aprobación |

Publicación de un post (tras aprobar): merge a `main`, push, **esperar deploy real de Vercel y confirmar 200 con curl**, y solo entonces IndexNow y Bing. Un post nuevo que compite con uno existente se **fusiona** al existente, no se duplica (ya es regla).

Flujo semanal:

```
Dom 18:00  Investigador -> topics (backlog ordenado)
Dom 20:00  Redactor     -> borrador post Lun  -> aprobación
Lun 09:00  publicar si aprobado (si no, espera; nunca auto en las primeras 4 semanas)
Mar 20:00  Redactor     -> borrador post Mie  -> aprobación
Mie 09:00  publicar si aprobado
Diario     Analista 06:30 -> Fixer 07:30
```

## 4. Suscripción y no API (crítico)

- Verificado hoy: `claude auth status` -> `authMethod: claude.ai`, sin `ANTHROPIC_API_KEY` en el shell.
- **Riesgo real**: `SEO-Watchdog/.env` **sí contiene `ANTHROPIC_API_KEY`** (lo usa `src/llm.ts` para "How to win"/descubrimiento). Si el runner hereda ese `.env`, `claude -p` usaría la API y cobraría por token en vez de la suscripción.
- Regla de diseño: el runner de agentes lanza `claude -p` con un entorno **construido desde cero** (PATH, HOME, lo mínimo) y **sin** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` ni similares. Al arrancar cada corrida se ejecuta `claude auth status` y se aborta si no dice `claude.ai`.
- Los agentes **no** importan `@anthropic-ai/sdk` ni `src/llm.ts`.
- **Única excepción autorizada:** búsqueda y descubrimiento de competidores sigue usando la API (`ANTHROPIC_API_KEY` en `.env`). Ese código corre en su propio proceso; el runner de agentes nunca recibe esa variable.
- Consecuencia: el uso cuenta contra el cupo de la suscripción, **compartido con tus sesiones interactivas**. No puedo ver el cupo restante desde aquí.
- Medición: cada corrida usa `--output-format json` y guarda tokens y duración en `runs`. Tras 1 semana se decide si alcanza o hay que espaciar/recortar.
- Protección: si una corrida falla por límite de uso, el job pasa a `waiting`, se reintenta más tarde y se avisa por Telegram. No se reintenta en bucle.

## 5. Seguridad y límites

- **Nunca** sin aprobación: checkout, pagos (Mercado Pago), emails transaccionales, redirects, rutas, `vercel.json`, variables de entorno, borrar contenido.
- Contenido Yume: precios siempre abren con "Primeras 100 piezas" (>100 = mayoreo); **no afirmar specs físicos** sin fuente verificada; **sin em-dashes** en copy nuevo; metas por `fitDescription()`.
- Sin `--dangerously-skip-permissions`. Cada agente tiene `--allowedTools` explícito y solo escribe dentro de su worktree (`/home/darrkito/yume-agent-wt`), nunca en el checkout principal.
- Cada cambio del Fixer es un commit separado y reversible (`git revert`).
- **Interruptor general** y **pausa por agente** en el dashboard. Tope de corridas por día y timeout por corrida.
- Un solo agente a la vez, `nice -n 19`, fuera de horas pico: `dca-mstr-bull` está en producción en la misma Pi.
- Credenciales: el `.env` lo crea el dueño a mano (un hook impide que yo lo escriba). Las claves nunca van a prompts ni logs.

## 6. Cambios en el Watchdog

Tablas nuevas en `data/watchdog.db`:

- `agent_settings(agent, site_id, enabled, autonomy, schedule)`
- `jobs(id, agent, site_id, run_at, status)`
- `runs(id, job_id, started, ended, status, tokens_in, tokens_out, output_path, error)`
- `approvals(id, kind, site_id, payload, diff_path, status, decided_at)`
- `metrics(date, site_id, source, page, query, clicks, impressions, position)`
- `topics(id, site_id, title, intent, evidence, score, status)`
- `posts(id, topic_id, slug, branch, state, published_at)`

Dashboard, pestaña **Agentes**: estado y última corrida por agente, interruptor, nivel de autonomía, cola de aprobaciones con diff, tokens de la semana, historial de posts.

Procesos: dashboard y scheduler bajo **pm2** (hoy corre con `nohup`).

## 7. Fases

| Fase | Entrega | Criterio de "hecho" |
|---|---|---|
| **0 Base** | Tablas, runner de `claude -p` con entorno limpio, chequeo de auth, registro de tokens, kill switch, pestaña Agentes mínima, pm2 | Un job de prueba corre por suscripción y queda en `runs` con tokens |
| **1 Datos + Analista** | Colector diario de GSC a `metrics`; Analista con resumen y alertas de caída | Un resumen real de Yume en el dashboard |
| **2 Investigador** | Backlog de temas con evidencia | 10 temas priorizados, sin canibalizar posts existentes |
| **3 Redactor** | Borrador + aprobación + publicación con verificación de deploy | Primer post publicado y verificado, objetivo lunes o miércoles de la próxima semana |
| **4 Fixer** | Cambios low-risk automáticos y cola de aprobación | Un lote de findings reales corregidos y revertibles |
| **5 Bing** | API de Webmaster Tools en el colector | Datos de Bing junto a los de GSC |

## 8. Cómo sabemos que funciona

Revisión semanal en el dashboard y cierre de evaluación a las 4 semanas (2026-11-23):

- Posts publicados: 2/2 por semana, tiempo de aprobación.
- GSC de Yume: clics, impresiones y posición media de las keywords seguidas, y páginas indexadas.
- Findings cerrados por el Fixer y cuántos se revirtieron.
- Temas del backlog que terminaron en post.
- Tokens por agente y por semana; si hubo corridas en `waiting` por límite.

Decisión a las 4 semanas: subir a publicación automática con checklist (si los borradores casi no necesitaron cambios), ajustar frecuencias, o agregar Codex.

## 9. Pendiente del dueño

1. Crear la clave de Bing Webmaster API y ponerla en `.env` (fase 5).
2. Poner `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` en `.env` si no están.
3. Lista de límites extra de Yume: claims prohibidos, páginas intocables, competidores que no se mencionan, temas vetados.
4. ~~Decidir qué hacer con `src/llm.ts`~~ **Decidido (2026-10-26):** la API de Anthropic se usa **solo** para la búsqueda y descubrimiento de competidores (`src/llm.ts` y `src/competitors.ts`, como hoy). Blogs, Analista, Investigador, Fixer y orquestación van **todo por suscripción**.
5. Confirmar los horarios de la sección 3.

## 10. Estado de la construcción (2026-10-26)

Construido, probado con datos reales de Yume y corriendo bajo pm2 (`seo-watchdog`, dashboard en http://127.0.0.1:4321/agents):

- Runner `claude -p` en suscripción con entorno de lista blanca (sin `ANTHROPIC_*`) y chequeo de `claude auth status`. Prueba automática: `test/agents.test.ts`.
- Colector GSC diario a `metrics` (462 filas de Yume desde 2026-08-31). Bing: la clave del dueño fue verificada contra la API (devuelve 38 filas de studioyume.mx), pero **no está en `.env`**, así que el colector de Bing no corre hasta que se agregue `BING_WEBMASTER_API_KEY`.
- Analista, Investigador, Redactor y Fixer corridos de verdad: informe semanal, 8 temas en el backlog, 2 borradores (1 fusión a un post existente, 1 post nuevo ES+EN) y 1 lote de fix, todos esperando aprobación en `/agents`.
- Scheduler en proceso (hora de Ciudad de México) que ya disparó crawl, collect, analyst y fixer del día por sí solo.
- Publicación: rebase sobre `main`, typecheck, push, espera del deploy real (200 en la URL **con una cadena que solo existe en la versión nueva**), y solo entonces IndexNow. Probada en un repo de juguete (incluye conflicto de rebase).
- Interruptor general, pausa por agente, autonomía del fixer y "Run now" en el dashboard.

Diferencias con el plan original:

- **Sin tablas `jobs`**: el scheduler calcula lo pendiente desde `agent_runs.slot`. Se agregarían si hiciera falta reintentos más complejos.
- **El Fixer arranca en "Ask me first"** (no auto-publica), aunque el plan decía auto en bajo riesgo. Se cambia con un clic en el dashboard tras ver los primeros lotes. Solo puede auto-publicar cambios dentro de `src/content/blog*.ts`; todo lo demás va a aprobación, y checkout, pagos, emails, `vercel.json`, `.env` y rutas API están bloqueados por código.
- **Telegram no está configurado** (`TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` faltan en `.env`): los avisos de borradores y fallos no llegan a ningún lado. Hay que revisar `/agents`.
- Los agentes escriben en un worktree propio (`/home/darrkito/yume-agent-wt`); el checkout del dueño nunca se toca.

Pendiente del dueño: `BING_WEBMASTER_API_KEY` y tokens de Telegram en `.env`, aprobar o rechazar los 3 elementos en cola (los 2 posts están fechados 2026-10-28), y la lista de límites extra de Yume.

### 10.1 Mejora de posts con un clic (2026-10-26)

Pestaña `/agents`, sección "Blog quality": puntaje 0-100 por post (estructura 70 pts: palabras, FAQ visible, schema, title, description, H1, enlaces internos; visibilidad en Google 30 pts) con la razón de cada punto perdido. Botón "Improve" por post y "Improve the 3 lowest". Cada clic manda el post al agente `improver` (el redactor en modo mejora, guiado por esas razones medidas); deja un borrador en "Waiting for you" y no se publica sin aprobación. No se vuelve a encolar un post con borrador pendiente o mejorado en los últimos 14 días. Primer caso real: `dulceros-para-graduacion` (puntaje más bajo) con borrador #4.

### 10.2 Giro hacia el cliente ideal (2026-10-26)

El dueño pidió reorientar el SEO hacia personas de alto poder adquisitivo que organizan celebraciones (bodas primero; baby shower, cumpleaños, bautizo, primera comunión, XV años, graduación) y empresas que organizan eventos (posadas, eventos corporativos), sin abandonar etiquetas y stickers pero sin atraer pedidos industriales o en serie. Su fuente: 3 notas de voz en `/home/darrkito/YumePhotos/Notes`.

- Brief resumido y con lenguaje cuidado: `src/agents/audience/studioyume.mx.md`. Se inyecta en el prompt del analista, investigador, redactor/mejorador y fixer.
- `src/agents/audience.ts` clasifica consultas, temas y posts en `event`, `corporate-event` (objetivo), `labels`, `bulk` y `other`.
- Investigador: al menos 6 de 8 temas para el cliente ideal, máximo 1 de etiquetas y con ángulo de evento. El redactor elige primero temas objetivo (+3) y último los de volumen (-4). Temas con ángulo industrial se descartan.
- Analista: informa qué parte de las impresiones de Google viene de eventos frente a etiquetas (`audienceSegments`), para medir si el giro funciona.
- Dashboard: columna "Speaks to" en Blog quality y botón "Improve the 3 lowest event posts".
- Límite de honestidad: solo se ofrece lo que Yume produce (8 productos en `products.ts` más los servicios por cotización existentes). No hay productos de boda en el catálogo: los posts de bodas llevan a cotizar por WhatsApp y marcan en `claims` lo pendiente de confirmar con el dueño.
- Pendiente del dueño: lista exacta de lo que Yume puede hacer para bodas y eventos (invitaciones, menús, tarjetas, etiquetas de copa, souvenirs...), y si quiere páginas de servicio dedicadas (/bodas, /eventos). Las páginas son código y pasarían por aprobación.

### 10.3 Aclaración del dueño (2026-10-26)

El cliente individual no tiene que dedicarse a organizar fiestas: puede ser cualquier mamá, papá o persona de a pie con alto poder adquisitivo que quiere hacerle algo bonito a un ser querido. Los **planners** (wedding planners, event planners) son los mejores aliados y ahora son un segmento propio (`planner`) con prioridad como los demás objetivos. El investigador debe incluir al menos 1 tema para planners por corrida. Primer tema en el backlog: guía para planners sobre cómo trabajar con un proveedor de detalles personalizados.

### 10.4 Página /planners y botones "Fix now" (2026-10-26)

- **/planners (ES) y /en/planners**: preparada en la rama `agent/page-planners` del repo de Yume (`PlannersPage.tsx`, dos rutas, mapa de rutas ES/EN, sitemap y enlace en el footer). Todo precio y tiempo sale de las constantes del catálogo. No ofrece descuentos ni comisiones para planners porque no hay condiciones definidas por el dueño. Typecheck y biome limpios; renderizada en un servidor de pruebas (200, canonical, hreflang, 3 bloques JSON-LD, precios correctos). Espera aprobación en `/agents` como tipo "Page".
- **Fix now**: en la pestaña "What to fix" de cada sitio configurado hay casillas por página y por tipo de problema, "Fix selected now" y "Fix all now (N)". En `/agents` hay "Fix all issues now (N)" por sitio. El clic encola al fixer con esos hallazgos (hasta 40 por corrida); el cambio queda como lote para aprobar, o se publica solo si el fixer está en "Auto-publish low-risk" y solo toca contenido del blog.
- Los trabajos del dashboard comparten un único worktree de agentes (`yume-agent-wt`): el trabajo manual en el repo de Yume debe hacerse en otro worktree.

### 10.5 Dizayn SEO en la flota, páginas por sitio y playbook de SEO (2026-10-26)

- **Páginas por sitio:** `/agents` es el resumen (interruptor general, pendientes de todos los sitios, tarjeta por sitio, uso de tokens). `/agents/yume` y `/agents/dizaynseo` son las páginas dedicadas de cada sitio (agentes, pendientes, backlog, corridas).
- **Dizayn SEO (www.dizaynseo.com, sitio #25):** corren crawl diario, colector, analista e investigador (en inglés, con prioridad en el grupo de contenido de Google Maps y SEO local y en visibilidad en IA). El redactor, el corrector y el mejorador **están apagados a propósito**: el sitio se genera con `tools/aeo/build.py` del socio, que no está en esta máquina; editar los HTML a mano rompería los gemelos markdown, sitemap, llms.txt y headers. Se activan cuando consigamos el generador. Brief propio: `src/agents/audience/dizaynseo.com.md`.
- **Falta para tener datos de dizaynseo:** agregar la cuenta de servicio del Watchdog a la propiedad de Search Console de dizaynseo.com (hoy ninguna llave tiene acceso) y dar de alta el sitio en Bing Webmaster (no aparece en la cuenta de la clave de API).
- **Playbook de SEO:** `src/agents/knowledge/seo-playbook.md`, destilado de "Get Found" (libro EPUB) y del estudio Whitespark 2026 Local Search Ranking Factors. Se inyecta en los prompts de todos los agentes. Auditoría de Yume contra el playbook: `docs/yume-vs-seo-playbook-2026-10-26.md`.
- **Robustez:** las ramas de borradores ahora son únicas por corrida (una repetición ya había sobrescrito la rama del borrador #15, que se rechazó y se volvió a redactar); las aprobaciones sin publicar se re-encolan al reiniciar; la verificación del deploy corre aparte para no bloquear el siguiente push.
