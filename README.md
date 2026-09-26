# Corrector98 🧹

Script de mantenimiento para la tabla `public.torrents` de Supabase. Se ejecuta a diario en **GitHub Actions** y limpia, normaliza, enriquece y deduplica la tabla. Está adaptado al esquema real de la tabla ([`sql/000_schema_reference.sql`](sql/000_schema_reference.sql)): columnas, CHECKs, longitudes de `varchar` e índices de consulta del addon.

| # | Paso (`STEPS`) | Qué hace |
|---|---|---|
| 1 | `adult` | Borra contenido adulto buscando en `title` y `title_text` (prefiltro `ILIKE` en Postgres, después regex con límites de palabra y lista blanca) |
| 2 | `size` | Borra fakes: `movie` < 150 MB, `series` < 30 MB (`size_bytes = 0` = desconocido, se conserva) |
| 3 | `dead` | Borra torrents con `seeders = 0` y `updated_at` de hace más de 30 días |
| 4 | `normalize` | Corrige `type`, `season`, `episode` y `absolute_episode` desde el título. **Nuevo:** rellena `quality`, `codec`, `hdr_format`, `channels` y `release_group` |
| 5 | `enrich` | Rellena IDs con AniList, Kitsu y TMDB. **Nuevo:** propagación local sin coste, estado en `ids_*` con backoff y solo torrents vivos |
| 6 | `dedupe` | Por obra y episodio conserva los **2 mejores en español** y los **2 mejores en inglés** (por seeders) y borra el resto |

Además: **informe de salud** con conteos antes y después, y **preservación de `updated_at`** (opcional, con [`sql/002`](sql/002_preserve_updated_at.sql)).

---

## 🚀 Activación

> ⚠️ GitHub **solo ejecuta los workflows programados (`schedule`) desde la rama por defecto** (`main`), y el botón *Run workflow* solo aparece cuando el archivo del workflow ya está en `main`. Para activarlo hay que **fusionar (merge) el Pull Request** de la rama `arena/01a0dbb0-corrector98` en `main`.

1. **Secrets** (*Settings → Secrets and variables → Actions → Secrets*):

   | Secret | Obligatorio | Descripción |
   |---|---|---|
   | `SUPABASE_URL` | ✅ | `https://xxxx.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Service role key. Hace falta para borrar y actualizar saltándose RLS |
   | `TMDB_API_KEY` | ➖ | API Key v3 o Read Access Token v4 (se detecta solo). Si no está, solo se enriquece el anime |

2. **SQL** (Supabase → SQL Editor), en este orden:
   - [`001_recommended_indexes.sql`](sql/001_recommended_indexes.sql): índices que complementan los que ya tienes (trigram, torrents muertos, candidatos a enriquecer). Son idempotentes y usan `CONCURRENTLY`.
   - [`002_preserve_updated_at.sql`](sql/002_preserve_updated_at.sql) (**muy recomendado**, ver abajo).
3. **Merge del PR** en `main`.
4. **Simulación**: *Actions → Mantenimiento de torrents → Run workflow* con **dry_run** marcado (es el valor por defecto). Revisa el *Job Summary*.
5. Si todo encaja, la ejecución programada (04:30 UTC diaria) aplica los cambios reales.

### Ejecución local
```bash
npm install
cp .env.example .env      # rellena las credenciales
npm run local:dry         # simulación
npm run local             # ejecución real
STEPS=dedupe npm run local:dry
npm test                  # 124 tests unitarios
```

---

## 🛡️ Seguridad

- **`DRY_RUN=true`**: no emite ni un `DELETE` ni un `UPDATE`.
- **`MAX_DELETE_RATIO`** (0.5): si en una ejecución se fuera a borrar más de ese porcentaje de la tabla, el paso se aborta **antes** de borrar y el job termina en rojo. En la primera ejecución el deduplicador puede superar legítimamente el 50 %; en ese caso sube el valor desde el input del workflow.
- **Validación contra el esquema**: `imdb_id ~ '^tt[0-9]+$'`, IDs `bigint > 0`, valores recortados a la longitud de cada `varchar`, `type` solo `movie`/`series`/`anime`, `season` y `episode` ≥ 0.
- **Nunca sobrescribe**: los IDs y metadatos solo se escriben en columnas `NULL` (o `quality = 'Unknown'`).
- **Columna `audio` ambigua**: solo cuentan como "otro idioma" los **códigos de idioma reconocidos**. Si `audio` guarda códecs (`AAC`, `DTS`…), se ignoran y el torrent **no** se borra por error.
- Si un paso falla, los demás se ejecutan igualmente, y `concurrency` evita ejecuciones solapadas.

### ¿Por qué `002_preserve_updated_at.sql`?
Tus triggers ponen `updated_at = now()` en **cualquier** UPDATE. Sin la migración, cada corrección del script "rejuvenece" el torrent, y el purgador de muertos (que depende de `updated_at`) tarda otros 30 días en eliminarlo. El script envía la cabecera `x-preserve-updated-at: true` y la función modificada conserva el valor anterior **solo** en ese caso: tu scraper y cualquier otro cliente siguen igual. Sin la migración, la cabecera se ignora sin ningún efecto secundario.

La migración también señala que tienes **dos triggers idénticos** (`trg_torrents_updated_at` y `update_torrents_updated_at`) y deja comentada la sentencia para eliminar el duplicado.

---

## Detalles por paso

### 1. Contenido adulto
Palabras clave en [`src/parsers/adult.js`](src/parsers/adult.js). Se descartan a propósito términos ambiguos ("sex", "hardcore"), y hay lista blanca para la saga **xXx**, el documental de *XXXTentacion* y el anime *Hentai Ouji*. Puedes añadir términos con `ADULT_EXTRA_KEYWORDS`.

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
5. `ENRICH_MAX_MINUTES` detiene el paso limpiamente antes del timeout de Actions.

### 6. Deduplicador
- Clave alineada con los índices del addon:
  - `imdb_id` / `tmdb_id` → `(id, season, episode)`, como `idx_torrents_stremio_imdb` e `idx_torrents_tmdb`.
  - `anilist_id` / `kitsu_id` / `mal_id` → `(id, episode, absolute_episode)`, como `idx_torrents_anilist/kitsu/mal`.
  - Las filas sin ningún ID no se tocan nunca.
- Idioma: **spanish** (castellano, latino, dual ES/EN, VOSE o subtítulos `spa`, trackers españoles), **english** (explícito o sin marcas) y **other** (FRENCH, VOSTFR, Dublado… sin inglés; `DEDUPE_OTHER_LANGUAGES=delete|keep`).
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
test/                   124 tests con node:test
sql/                    000 esquema (referencia) · 001 índices · 002 preservar updated_at
.github/workflows/      Workflow programado y manual
```

Todas las opciones configurables están en [`.env.example`](.env.example).
