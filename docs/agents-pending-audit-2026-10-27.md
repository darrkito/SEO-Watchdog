# Qué faltaba aplicar a los agentes (auditoría 2026-10-27)

Pregunta del dueño: ¿hay algo pendiente de aplicar a los agentes de lo aprendido hoy, del libro (Get Found) y de la página nueva de Dizayn SEO? Resultado: sí. Esto es lo que se encontró, qué se aplicó ya y qué sigue pendiente.

## Aplicado hoy

| # | Origen | Qué faltaba | Qué se hizo |
|---|---|---|---|
| 1 | Dizayn SEO (hoy) | El brief y el contexto del investigador decían "nearshore, desde Guadalajara", Founding 40% x 3 cupos y "análisis normalmente $750". Ya no es cierto: solo EE.UU., sede San Antonio TX, Starter $540 / Complete $1,200, planes $99 / $450 mes a mes, Founding 5 cupos a $300 de por vida. | `audience/dizaynseo.com.md` reescrito y `research.context/priority` de `sites.ts` corregidos (también: no proponer temas de "contratar una agencia en México"). Los 8 temas del backlog siguen siendo válidos (todos de Maps/SEO local/IA). |
| 2 | Hoy (lección) | Ningún agente sabía que un dato de negocio (precio, ubicación, garantía, plazo mínimo) debe existir en un solo lugar y actualizarse en todo lo derivado; ni que "hipótesis" no se amplía; ni que los datos de los clientes no cambian si cambia el negocio propio. | Sección G del `knowledge/seo-playbook.md` (se inyecta en todos los prompts) y reglas por sitio en `sites.ts` (precios solo del repo, nada de "POR CONFIRMAR" en Vexon, no inventar eventos/reseñas en Luvory). |
| 3 | Hoy (lección) | `tools/aeo/build.py` sigue sin estar en esta máquina; un cambio de precios en todo el sitio solo fue posible con un flujo manual de build + fusión. | El `pendingNote` de dizaynseo lo dice; redactor/corrector/mejorador siguen apagados ahí. El botón "Write now" muestra "Writer off" en ese sitio. |
| 4 | Libro: mini auditoría | El libro pide comparar contra la página #1 (palabras, H2, usos de la palabra clave) antes de escribir y superarla ligeramente. El redactor solo tenía la regla en el playbook, no como paso. | `MINI_AUDIT` en el prompt de todo borrador: buscar la consulta, abrir los 3 primeros, cubrir lo mismo con otras palabras, palabra clave en title/meta/URL/H1/H2, mínimo 3 enlaces internos con 1 a la página que vende. |
| 5 | Libro: palabras clave | El investigador no tenía los criterios de elección (long-tail, intención, perenne vs tendencia, geolocalizada, baja dificultad, avalancha). | `KEYWORD_CRITERIA` en el prompt del investigador; pide verificar en los primeros resultados y decirlo en "why". |
| 6 | Libro: "si el tráfico cae tras editar, esperar y revertir" | Nadie vigilaba el efecto de los posts que publican o mejoran los agentes. | `postEffects()`: impresiones y clics por día, 28 días antes contra los días desde la publicación, por post; entra al resumen semanal y el analista recomienda esperar/revertir si cae más de 40%. |
| 7 | Libro: "una pregunta de un cliente es un post" | No había dónde dar las preguntas reales de WhatsApp/ventas. | Archivo opcional `audience/<host>.questions.md` que se inyecta al investigador cuando exista. |
| 8 | Dueño (hoy) | Luvory y Vexon no estaban en la flota. | Ambos agregados con agentes completos (crawl, colector, analista, investigador, redactor, corrector, mejorador), briefs de audiencia, reglas duras de cada repo y chequeos deterministas (ver PLAN-agents-yume.md §10.6). |
| 9 | Dueño (hoy) | El backlog de temas solo se leía; el redactor elegía el tema por su cuenta los domingos y martes. | Botón "Write now" en cada tema: redacta ese tema ya (5 a 10 min); el borrador queda en "Waiting for you" y nada sale sin aprobación. |

## Sigue pendiente

**Del dueño**
- Vexon: ninguna cuenta de servicio tiene acceso a Search Console de vexonmexico.com.mx. Hasta entonces el analista y el puntaje de blog no tienen datos de Google. Dizayn SEO tiene el mismo problema.
- `BING_WEBMASTER_API_KEY` ya existe para Yume pero no se ha verificado para Luvory, Vexon ni Dizayn SEO; y `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` siguen sin ponerse (los avisos de "borrador listo" no llegan).
- Luvory: publicar en main NO pone el sitio en vivo; hay que pulsar Publish en Lovable (la alerta lo recuerda y el chequeo espera hasta 12 h).
- Vexon: confirmar plazo mínimo, entrega, cobertura, qué incluye el servicio y facturación (los textos "POR CONFIRMAR" de `src/data/faqs.ts`). Mientras tanto el redactor tiene prohibido afirmarlos.
- Preguntas reales de clientes (WhatsApp, ventas) de cada negocio para `audience/<host>.questions.md`.
- Dizayn SEO: sigue el teléfono +52 en el sitio, sin dirección ni coordenadas de San Antonio y sin decidir W-9; no son tareas de agente.

**De desarrollo (no hechas a propósito)**
- **Páginas por servicio / ocasión.** Whitespark pone "una página dedicada por servicio" como factor #1 en orgánico local y #2 en IA; los agentes solo escriben posts. Hace falta un agente de páginas (hay tipo de aprobación `page`, sin productor).
- **Puntaje de blog con palabra clave y enlaces.** El puntaje no mide si la palabra clave principal está en title/H1, si el post enlaza a la página que vende, ni alt de imágenes y una imagen por ~200 palabras: `extract.ts` no guarda imágenes ni distingue enlaces del contenido. Requiere ampliar el extractor.
- **Imágenes.** Los redactores no pueden agregar fotos propias (no tienen assets); el libro pide una cada ~200 palabras con alt.
- **Reseñas, categorías de GBP y citas** (los factores más pesados en Maps) son acciones del dueño; el analista podría llevar una lista de pendientes del dueño con fecha, hoy solo las menciona.
- **Re-medir** el efecto de todo esto a las 4 semanas (2026-11-23): borradores aprobados/rechazados por sitio, `effectOfOurPosts`, tokens por agente.
