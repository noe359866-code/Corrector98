# Corrector98 🧹

Script de mantenimiento para la tabla `torrents` de Supabase, pensado para ejecutarse a diario en **GitHub Actions**. Hace seis cosas: limpia, normaliza, enriquece y deduplica la tabla.

| # | Paso (`STEPS`) | Qué hace |
|---|---|---|
| 1 | `adult` | Borra títulos con contenido adulto (prefiltro `ILIKE` en Postgres y después una regex con límites de palabra y lista blanca) |
| 2 | `size` | Borra fakes: `movie` < 150 MB, `series` < 30 MB |
| 3 | `dead` | Borra torrents con `seeders = 0` y `updated_at` de hace más de 30 días |
| 4 | `normalize` | Lee el `title` y corrige `type`, `season`, `episode` y `absolute_episode` |
| 5 | `enrich` | Rellena los IDs que faltan con AniList, Kitsu y TMDB (incluido `imdb_id` y `mal_id`) |
| 6 | `dedupe` | Por obra, temporada y episodio conserva los **2 mejores en español** y los **2 mejores en inglés** (por seeders) y borra el resto |

## Puesta en marcha

### 1. Secrets de GitHub
En *Settings → Secrets and variables → Actions → Secrets*:

| Secret | Obligatorio | Descripción |
|---|---|---|
| `SUPABASE_URL` | ✅ | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Service role key. Hace falta para borrar y actualizar saltándose RLS |
| `TMDB_API_KEY` | ➖ | API Key v3 o Read Access Token v4 (se detecta solo). Si no está, solo se enriquece el anime |

### 2. Índices (recomendado)
Ejecuta [`sql/recommended_indexes.sql`](sql/recommended_indexes.sql) en el SQL Editor de Supabase. Con estos índices, los filtros de los pasos 1, 2, 3 y 5 dejan de recorrer la tabla entera.

### 3. Primera ejecución: simulación
En *Actions → Mantenimiento de torrents → Run workflow*, deja marcado **dry_run** (es el valor por defecto). En el log y en el *Job Summary* verás cuántas filas borraría o actualizaría cada paso, con ejemplos, y la base de datos no se modifica.

Cuando el resultado te convenza, la ejecución programada (diaria a las 04:30 UTC) hace los cambios reales.

### Ejecución local
```bash
npm install
cp .env.example .env      # rellena las credenciales
npm run local:dry         # simulación
npm run local             # ejecución real
STEPS=dedupe npm run local:dry   # solo un paso
npm test                  # tests unitarios
```

## Mecanismos de seguridad

- **`DRY_RUN=true`**: no emite ni un `DELETE` ni un `UPDATE`.
- **`MAX_DELETE_RATIO`** (0.5 por defecto): si en una ejecución se fuera a borrar más de ese porcentaje de la tabla, el paso se aborta **antes** de borrar nada y el job termina en rojo. En la primera ejecución real el deduplicador puede superar legítimamente el 50 %; en ese caso sube el valor desde el input del workflow.
- **Nunca se sobrescriben IDs**: el enriquecedor hace `UPDATE … WHERE columna IS NULL`.
- **Validación de coincidencias**: los resultados de las APIs se aceptan solo si el título se parece lo suficiente (Sørensen-Dice ≥ `MATCH_THRESHOLD`) y el año encaja.
- **Aislamiento de pasos**: si un paso falla, los demás se ejecutan igualmente y el job termina con código 1.
- **Sin ejecuciones solapadas** gracias a `concurrency` en el workflow.

## Detalles de cada paso

### 1. Contenido adulto
Palabras clave en [`src/parsers/adult.js`](src/parsers/adult.js). Se descartan a propósito términos ambiguos como "sex" o "hardcore" (*Sex Education*, *Hardcore Henry*), y hay lista blanca para la saga **xXx** de Vin Diesel, el documental de *XXXTentacion* y el anime *Hentai Ouji*. Puedes añadir términos con `ADULT_EXTRA_KEYWORDS=palabra1,palabra2`.

### 2. Anti-fakes por tamaño
- Las filas con `size_bytes` NULL nunca se tocan. Las de `size_bytes = 0` se consideran de tamaño desconocido y se conservan, salvo que pongas `SIZE_FILTER_INCLUDE_ZERO=true`.
- Si una "película" pequeña tiene título de episodio (`S01E05`, `[SubsPlease] X - 05`), está mal tipada y **no se borra**: el paso 4 la re-tipa y la siguiente ejecución la evalúa con el umbral correcto.

### 4. Parser de títulos
Formatos reconocidos: `S02E09`, `S02E09E10`, `S02E01-E06`, `2x09`, `[Cap.209]` y `[Cap.1012]` (trackers españoles), `[Cap.101_110]`, `Temporada 2`, `Season 2`, `S01-S05`, `[Grupo] Show - 09`, `S2 - 09`, `2nd Season - 09`, `One Piece - 1071` (episodio absoluto).

Reglas conservadoras:
- El tipo solo cambia si la confianza es alta o media. Un `anime` nunca pasa a `series` (muchos animes usan SxxEyy) y una serie nunca pasa a `movie`.
- **En packs (temporada completa o rango de episodios) el `episode` no se toca**, porque cada fila suele corresponder a un archivo distinto dentro del torrent.
- La lista de grupos de anime está en `ANIME_RELEASE_GROUPS` ([`title-parser.js`](src/parsers/title-parser.js)).

### 5. Enriquecedor
- Una consulta por **obra**, no por fila. Las obras con más filas afectadas van primero y hay un tope de `ENRICH_MAX_TITLES` por ejecución.
- Cuando hay un identificador, se hace una búsqueda exacta: `imdb_id` → TMDB `/find`, `tmdb_id` → `/external_ids`, `mal_id` → mapping de Kitsu. Solo se busca por título si no hay ninguno.
- TMDB se consulta primero en `en-US` y, si no hay coincidencia, en `es-ES` (los trackers hispanos usan títulos traducidos).
- Rate limit propio por API, reintentos con backoff y respeto de `Retry-After`.
- Las búsquedas sin resultado se guardan en `.enrich-cache.json` durante `ENRICH_MISS_TTL_DAYS` días (el workflow lo conserva con `actions/cache`), para no gastar cuota repitiéndolas cada día.

### 6. Deduplicador
- Clave de grupo: `imdb_id`, si no `tmdb_id` (junto con movie/tv, porque los IDs de TMDB se repiten entre ambos), si no `anilist_id`, si no `kitsu_id`, más `season` y `episode`. **Las filas sin ningún ID no se deduplican nunca.**
- Idioma, según [`language.js`](src/parsers/language.js):
  - **spanish**: castellano, latino, dual ES/EN, VOSE/subtitulado o subtítulos `spa`, y releases de trackers españoles.
  - **english**: inglés explícito, o un release sin ninguna marca de idioma (la escena internacional y los fansubs de anime no suelen indicarlo).
  - **other**: otro idioma explícito (FRENCH, VOSTFR, Dublado…) sin inglés. Con `DEDUPE_OTHER_LANGUAGES=delete` (la regla estricta, por defecto) se borran; con `keep`, se conservan.
- Orden: seeders de mayor a menor; en caso de empate, más tamaño y después el `id`, para que el resultado sea determinista. Las filas con el mismo `info_hash` dentro de un grupo se eliminan antes de aplicar el top 2.

## Estructura

```
src/
  index.js              Orquestador (pipeline, resumen, código de salida)
  config.js             Variables de entorno y validación
  lib/                  db (Supabase, paginación keyset, borrados por lotes), http, logger, utils
  parsers/              Funciones puras: títulos, idioma, limpieza/similitud, adulto
  providers/            Clientes de AniList, Kitsu y TMDB
  steps/                Un archivo por paso (01…06)
test/                   Tests con node:test
sql/                    Índices recomendados
.github/workflows/      Workflow programado y manual
```

## Rendimiento

- **Paginación keyset** (`id > último ORDER BY id`): coste lineal, no se degrada en tablas grandes y es estable aunque se borren filas mientras se recorre.
- `DELETE` y `UPDATE` por lotes con `id IN (…)`; los patches idénticos se agrupan en una sola consulta.
- El deduplicador guarda en memoria solo una tupla compacta por fila.
