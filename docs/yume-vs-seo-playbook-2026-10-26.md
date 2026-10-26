# Yume contra el playbook de SEO (auditoría, 2026-10-26)

Base: crawl del 26 de octubre (118 páginas con 200) contra `src/agents/knowledge/seo-playbook.md` (libro "Get Found" + Whitespark 2026). Los números salen del último crawl del Watchdog.

## Lo que ya cumple

| Regla del playbook | Estado en Yume |
|---|---|
| Title ≤ 60 caracteres, único | 94% de los posts y 94% de las demás páginas; 0% de productos y home se pasan |
| Meta description entre 80 y 160 | 0% fuera de rango en todos los tipos de página |
| Un solo H1 por página | 100% en posts, productos y home; 11% de "otras" páginas con 0 o 2 H1 (el carrito ya está en corrección) |
| Páginas de producto con FAQ y contenido | 14 de 14 con FAQ (6 a 9 preguntas) y 832 palabras en promedio |
| Schema, sitemap, hreflang ES/EN, mapa de rutas | Presentes |

## Brechas, de mayor a menor impacto

1. **Posts delgados y sin FAQ.** De 84 páginas de blog (42 posts × ES/EN), **77% tiene menos de 500 palabras y solo 5% tiene FAQ visible**. El libro pide ser *ligeramente* más completo que el #1 y Whitespark da prioridad a contenido escaneable con encabezados claros. Acción en curso: el mejorador ya reescribió varios posts bajos; falta el resto de los 42 (puntaje promedio bajo en `/agents/yume`).
2. **Faltan páginas dedicadas por ocasión y por servicio.** Es el factor #1 de los resultados orgánicos locales y el #2 de visibilidad en IA (Whitespark 2026). Yume tiene páginas de producto, pero no una página por ocasión para su cliente ideal. Propuesta: `/bodas`, `/baby-shower`, `/bautizos-y-primera-comunion`, `/xv-anos`, `/graduaciones` y `/eventos-de-empresa` (posadas, aniversarios), cada una con qué piezas se pueden pedir (dulceros, stickers, tatuajes, menús e invitaciones por cotización), costo o rango, tiempos, FAQ y llamada a WhatsApp, y enlazada desde los posts de esa ocasión. `/planners` ya está publicada como la primera. **Bloqueo: necesito la lista exacta de lo que Yume puede hacer para bodas y eventos.**
3. **Enlazado interno de los posts a las páginas que venden.** El libro pide 3 a 5 enlaces internos con ancla descriptiva y al menos uno a producto o servicio. Los posts mejorados ya lo incluyen; falta auditar los demás.
4. **Páginas "otras" delgadas** (78% con menos de 500 palabras; 56% con menos de 300): son políticas, contacto y similares, donde es normal; no es prioridad.
5. **Reseñas y señales locales.** Whitespark 2026 coloca calificaciones altas, cantidad de reseñas con texto, recencia y velocidad sostenida entre los factores más importantes del Map Pack y de la visibilidad en IA. Yume declara en "Nosotros" que aún no tiene reseñas publicadas. Palanca principal: pedir reseñas reales a cada cliente (Google Customer Reviews ya está activo; la placa NFC de Yume sirve para esto), responder todas y repartirlas en más de un sitio.
6. **Google Business Profile y NAP (a confirmar por el dueño).** Yume es tienda en línea con taller en Guadalajara, sin mostrador. Si el perfil es de "negocio de área de servicio", **no debe mostrar la dirección** (factor negativo y riesgo de suspensión). Revisar categoría principal, servicios con palabras clave, horarios reales y que nombre, dirección y teléfono sean idénticos en todo. Importar el perfil a Bing Places.
7. **Citas no estructuradas y listas "lo mejor de".** Los tres primeros factores de visibilidad en IA son listas de expertos, páginas de servicio y citas. Plan: conseguir menciones en blogs de bodas y fiestas de Guadalajara, directorios de proveedores de bodas y eventos, y notas de prensa local; **nunca inventarlas**.

## Qué hacen los agentes con esto

- El playbook se agrega al prompt de todos los agentes (analista, investigador, redactor, mejorador, corrector).
- El investigador propone temas con intención long-tail, geolocalizados y sin canibalizar posts existentes.
- El redactor y el mejorador aplican las reglas de la sección B y F del playbook en cada post.
- Las brechas 2, 5, 6 y 7 requieren decisiones del dueño; las dos primeras se pueden ejecutar de inmediato con el visto bueno y la lista de lo que Yume produce para bodas.
