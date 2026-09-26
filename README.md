# Corrector98 🧹

Script de mantenimiento para la tabla `public.torrents` de Supabase. Analiza a diario en **GitHub Actions sin escribir**. Los cambios reales se ejecutan aparte, de forma manual y con controles de autorización y auditoría. Está adaptado al esquema real de la tabla ([`sql/000_schema_reference.sql`](sql/000_schema_reference.sql)): columnas, CHECKs, longitudes de `varchar` e índices de consulta del addon.

| # | Paso (`STEPS`) | Qué hace |
|---|---|---|
| 1 | `adult` | Borra contenido adulto buscando en `title` y `title_text` (prefiltro `ILIKE` en Postgres, después regex con límites de palabra y lista blanca) |
| 2 | `size` | Borra fakes: `movie` < 150 MB, `series` < 30 MB (`size_bytes = 0` = desconocido, se conserva) |
| 3 | `dead` | Borra torrents con `seeders = 0` y `updated_at` de hace más de 30 días |
| 4 | `normalize` | Corrige `type`, `season`, `episode` y `absolute_episode` desde el título. **Nuevo:** rellena `quality`, `codec`, `hdr_format`, `channels` y `release_group` |
| 5 | `enrich` | Rellena IDs con AniList, Kitsu y TMDB. **Nuevo:** propagación local sin coste, estado en `ids_*` con backoff y solo torrents vivos |
| 6 | `dedupe` | Por obra y episodio conserva los **2 mejores en español** y los **2 mejores en inglés** (por seeders) y elimina los excedentes de esos idiomas; conserva otros idiomas por defecto |

Además: **informe de salud** con conteos antes y después, y **preservación de `updated_at`** (opcional, con [`sql/002`](sql/002_preserve_updated_at.sql)).

---

## 🚀 Activación

> ⚠️ GitHub **solo ejecuta los workflows programados (`schedule`) desde la rama por defecto** (`main`), y el botón *Run workflow* solo aparece cuando el archivo del workflow ya está en `main`. Para activarlo hay que **fusionar (merge) el Pull Request** con estos cambios en `main`.

1. Configura los entornos y permisos siguiendo [el manual de operación](docs/OPERATIONS.md):

   | Entorno | Secrets | Uso |
   |---|---|---|
   | `maintenance-scan` | `SUPABASE_URL`, `SUPABASE_READ_KEY`, opcional `TMDB_API_KEY` | Análisis sin escrituras |
   | `production-maintenance` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, opcional `TMDB_API_KEY` | Aplicación manual autorizada |

   **Obligatorio antes de producción:** configurar revisores requeridos, impedir autoaprobación y restringir el entorno de producción a la rama por defecto. El YAML referencia el entorno pero **no configura esas protecciones**. No guardes la service-role como secret global del repositorio. La clave de lectura debe tener permisos reales de solo SELECT; cambiarle el nombre a una service-role no reduce sus privilegios.
2. Revisa y aplica las migraciones necesarias en staging primero: [`001`](sql/001_recommended_indexes.sql) (índices) y [`002`](sql/002_preserve_updated_at.sql) (conservar `updated_at`). No se ejecutan automáticamente.
3. Fusiona el PR después de pasar **CI** (Node 22/24, pruebas y auditoría de dependencias). Las Actions están fijadas por SHA y Dependabot propone actualizaciones.
4. Ejecuta **Análisis de mantenimiento (sin escrituras)**. La programación diaria de las 04:30 UTC también es **solo análisis**. Revisa el resumen, el artefacto de auditoría y los falsos positivos en staging.
5. Para escribir usa **Aplicar mantenimiento aprobado**, desde la rama por defecto. Indica `APPLY:torrents`, referencia del cambio, referencia del respaldo verificado, pasos y límites. El job espera las protecciones configuradas del entorno. **No se ha activado ningún permiso o entorno remoto desde este cambio de código.**

### Ejecución local
Requiere **Node.js 22 o superior** (CI en 22 y 24), en línea con la dependencia de Supabase.

```bash
npm ci --ignore-scripts
cp .env.example .env       # configura la clave de lectura, sin compartirla
npm run local:dry          # análisis; genera audit/<runId>.jsonl
STEPS=dedupe npm run local:dry
npm test
```

Para aplicar, después de verificar un respaldo y el cambio (ejemplo, reemplaza las referencias):
```bash
DRY_RUN=false APPLY_CONFIRMATION=APPLY:torrents \
CHANGE_TICKET=CAMBIO-123 BACKUP_REFERENCE=respaldo-verificado \
STEPS=dead npm run local
```
La ejecución local **no impone revisión de una segunda persona**. Para producción utiliza el workflow protegido.

---

## 🛡️ Seguridad

- **`DRY_RUN=true` por defecto**: no emite ni un `DELETE` ni un `UPDATE`. Para escribir se requieren además `APPLY_CONFIRMATION`, `CHANGE_TICKET`, `BACKUP_REFERENCE` y `STEPS` explícitos. La simulación usa únicamente `SUPABASE_READ_KEY`, sin fallback a service-role. Los borrados simulados se cuentan una sola vez y se excluyen de los escaneos posteriores. Las actualizaciones no se simulan en memoria: el resultado de `enrich`/`dedupe` puede diferir de una ejecución real.
- **`MAX_DELETE_RATIO`** (0.1) y **`MAX_DELETE_ROWS`** (1000): presupuesto **acumulado** sobre un conteo inicial **exacto**, nunca estimado. Cada solicitud valida todos sus IDs antes del primer lote; si supera el presupuesto restante, no empieza a borrar. Los lotes previos confirmados sí permanecen borrados (no hay rollback global). Un error de escritura bloquea los borrados posteriores para no arriesgarse a superar el tope si el servidor confirmó una operación pero se perdió su respuesta. Se aplica siempre el menor de ambos límites. Si el plan los supera, requiere otra revisión; no se aumentan automáticamente.
- **Validación contra el esquema**: `imdb_id ~ '^tt[0-9]+$'`, IDs `bigint > 0`, valores recortados a la longitud de cada `varchar`, `type` solo `movie`/`series`/`anime`, `season` y `episode` ≥ 0.
- **IDs y metadatos**: se rellenan columnas vacías (`quality` también si vale `Unknown`). El normalizador comprueba en el propio UPDATE que los campos mantienen su valor leído, incluso al reintentar fila a fila; si un scraper los cambió, omite esa actualización. Las correcciones estructurales (`type`, temporada y episodio) sí pueden cambiar valores existentes.
- **Columna `audio` ambigua**: solo cuentan como "otro idioma" los **códigos de idioma reconocidos**. Si `audio` guarda códecs (`AAC`, `DTS`…), se ignoran y el torrent **no** se borra por error.
- **Parada ante fallos**: un paso fallido, errores de enriquecimiento o fallos por fila bloquean los pasos siguientes y hacen fallar el job. No se deduplica sobre un enriquecimiento/normalización fallido. `concurrency` coordina los dos workflows operativos, no otros clientes externos.
- **Auditoría obligatoria de escrituras**: cada lote registra intención durable antes de enviar la petición y recibo después, con ID de ejecución, operación, IDs candidatos y conteo confirmado. Si falla el diario, no se autorizan nuevas escrituras. Los cambios ya enviados no se revierten. Los registros se guardan con permisos `0600` y los artefactos de Actions se retienen 30 días. Ver [límites y recuperación](docs/OPERATIONS.md).
- **Privacidad**: secretos conocidos, tokens bearer y claves de API en URLs se redactan en los logs; los ejemplos de títulos están desactivados (`LOG_SAMPLES=false`). No activar DEBUG en producción sin revisar el contenido.
- **Configuración estricta**: booleanos mal escritos, enteros truncados, lotes vacíos, retención de cero copias y rangos peligrosos se rechazan antes de conectar.
- **Borrados de muertos y por tamaño**: revalidan sus condiciones SQL al ejecutar el DELETE; un torrent recuperado o cuyo tamaño/tipo ya se corrigió no se borra usando únicamente el estado antiguo.

### Escaneo y consumo de memoria

- Paginación por clave (`id > último`), sin OFFSET. Continúa hasta una página vacía aunque el `max_rows` de Supabase sea inferior a `PAGE_SIZE`.
- Cada escaneo fija un ID máximo inicial; las nuevas inserciones con IDs mayores se procesan en la próxima pasada. Detecta cursores repetidos, respuestas inválidas e IDs numéricos que perderían precisión (`bigint` recibido como string sí es seguro).
- Peticiones a Supabase con timeout (`DB_TIMEOUT_MS=30000`) y lecturas con reintentos limitados (`DB_READ_RETRIES=3`) ante fallos transitorios. Los DELETE no se reintentan automáticamente desde la aplicación.
- El normalizador agrupa y escribe **por página**, sin acumular todas las correcciones de la tabla en memoria. Los eliminadores conservan su plan de IDs para validar el presupuesto antes de borrar; la deduplicación sigue necesitando agrupar candidatos en memoria.
- No hay snapshot transaccional entre páginas. Los cambios externos de título/IDs durante el filtro adulto o la deduplicación no se revalidan completamente al borrar: ejecuta esos pasos en una ventana sin escrituras del scraper si necesitas evitar esa carrera.

### ¿Por qué `002_preserve_updated_at.sql`?
Tus triggers ponen `updated_at = now()` en **cualquier** UPDATE. Sin la migración, cada corrección del script "rejuvenece" el torrent, y el purgador de muertos (que depende de `updated_at`) tarda otros 30 días en eliminarlo. El script envía la cabecera `x-preserve-updated-at: true` y la función modificada conserva el valor anterior **solo** en ese caso: tu scraper y cualquier otro cliente siguen igual. Sin la migración, la cabecera se ignora sin ningún efecto secundario.

La migración también señala que tienes **dos triggers idénticos** (`trg_torrents_updated_at` y `update_torrents_updated_at`) y deja comentada la sentencia para eliminar el duplicado.

---

## Detalles por paso

### 1. Contenido adulto
Palabras clave en [`src/parsers/adult.js`](src/parsers/adult.js). Se descartan a propósito términos ambiguos ("sex", "hardcore"), y hay lista blanca para la saga **xXx**, el documental de *XXXTentacion* y el anime *Hentai Ouji*. Puedes añadir términos con `ADULT_EXTRA_KEYWORDS`. Se rechazan palabras vacías o formadas solo por comodines; los términos cortos también participan en el prefiltro. Una excepción de la lista blanca no oculta otras señales adultas independientes en el mismo título.

### 2. Anti-fakes por tamaño
Si una "película" pequeña tiene título de episodio (`S01E05`), está mal tipada y no se borra: el paso 4 la re-tipa.

### 4. Normalizador y metadatos
- Formatos: `S02E09`, `S02E09E10`, `S02E01-E06`, `2x09`, `[Cap.209]`, `[Cap.101_110]`, `Temporada 2`, `S01-S05`, `[Grupo] Show - 09`, `S2 - 09`, `2nd Season - 09`, `One Piece - 1071`.
- Un `anime` nunca pasa a `series`, y en packs el `episode` no se toca.
- **Metadatos** (`FILL_METADATA=true`):

  | Columna | Valores |
  |---|---|
  | `quality` | `2160p`, `1080p`, `720p`, `480p`, `CAM` (solo si vale `'Unknown'`) |
  | `codec` | `HEVC`, `AVC`, `AV1`, `VP9`, `XviD`, `DivX`, `MPEG2` |
  | `hdr_format` | `DV+HDR10+`, `DV+HDR10`, `DV`, `HDR10+`, `HDR10`, `HDR`, `HLG` |
  | `channels` | `7.1`, `5.1`, `2.0`… |
  | `release_group` | `[SubsPlease]` al inicio o `-GRUPO` al final |

### 5. Enriquecedor
1. **Solo torrents vivos** (`seeders >= ENRICH_MIN_SEEDERS`): no se gasta cuota de API en muertos.
2. **Propagación local** (gratis): si otro torrent ya identificado tiene el mismo título limpio, año y tipo, se copian sus IDs (`ids_source = 'local'`). Si los candidatos a donante no coinciden entre sí (obras homónimas), no se copia nada.
3. **APIs**, una consulta por obra: `imdb_id` → TMDB `/find`, `tmdb_id` → `/external_ids`, `mal_id` → mapping de Kitsu, y si no, búsqueda por título validada por similitud y año. Para buscar se usa `title_text` si existe.
4. **Estado en la tabla**: `ids_checked_at`, `ids_attempts` (+1), `ids_source` (`anilist+kitsu+tmdb`, `local`…) e `ids_confidence` (similitud). Las obras sin resultado se reintentan a las 24 h, luego 48 h, 96 h… hasta 30 días. Un error de red no penaliza.
5. `ENRICH_MAX_TITLES=0` (por defecto) consulta todas las obras pendientes sin el antiguo tope de 400. Se aplica a TMDB, AniList y Kitsu; un valor positivo permite fijar un tope. Si ya tienes la variable de repositorio `ENRICH_MAX_TITLES=400` en GitHub Actions, cámbiala a `0` o elimínala. Se mantienen las pausas de cada proveedor (`TMDB_RPM`, etc.): sin límite de títulos no significa peticiones ilimitadas por segundo.
6. `ENRICH_MAX_MINUTES` detiene el paso limpiamente antes del timeout de Actions (45 minutos por defecto). Por tanto, la ejecución no es infinita: termina al completar las obras pendientes o agotar ese tiempo.

### 6. Deduplicador
- Conserva filas con episodios/temporadas incompletos, títulos que contradicen las coordenadas guardadas y packs sin un archivo y episodio identificados. También conserva anime sin episodio identificable (incluidas películas anime ambiguas).
- Los duplicados de hash tienen en cuenta `file_index`. Solo se consideran duplicados de **copias conservadas**, no de filas que ya iban a eliminarse por idioma o exceso.
- Clave alineada con los índices del addon:
  - `imdb_id` / `tmdb_id` → `(id, season, episode)`, como `idx_torrents_stremio_imdb` e `idx_torrents_tmdb`.
  - `anilist_id` / `kitsu_id` / `mal_id` → `(id, episode, absolute_episode)`, como `idx_torrents_anilist/kitsu/mal`.
  - Las filas sin ningún ID no se tocan nunca.
- Idioma: **spanish** (castellano, latino, dual ES/EN, VOSE o subtítulos `spa`, trackers españoles), **english** (explícito o sin marcas) y **other** (FRENCH, VOSTFR, Dublado… sin inglés; `DEDUPE_OTHER_LANGUAGES=keep` por defecto; `delete` solo por decisión explícita).
- Orden: seeders, después **calidad** (2160p > 1080p > 720p…), tamaño e `id`.

---

## Estructura

```
src/
  index.js              Orquestador (pipeline, informe de salud, resumen, código de salida)
  config.js             Variables de entorno y validación
  lib/                  db (Supabase, keyset, lotes), http (rate limit + reintentos), report, logger, utils
  parsers/              Funciones puras: títulos, metadatos, idioma, limpieza/similitud, adulto
  providers/            Clientes de AniList, Kitsu y TMDB
  steps/                Un archivo por paso (01…06)
test/                   Pruebas con node:test (sin credenciales ni acceso a la BD real)
sql/                    000 esquema (referencia) · 001 índices · 002 preservar updated_at
.github/workflows/      CI · análisis programado · aplicación manual protegida
docs/OPERATIONS.md      Aprobación, despliegue, auditoría e incidentes
```

Todas las opciones configurables están en [`.env.example`](.env.example).
