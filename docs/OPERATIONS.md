# Manual de operación y control de cambios

Este proyecto incorpora barreras técnicas para reducir errores operativos. **No es una certificación de seguridad, una plataforma de backups ni una garantía de recuperación.** Las protecciones de GitHub, los privilegios de Supabase y los respaldos se configuran y verifican fuera del código.

## 1. Responsabilidades y permisos

| Responsable | Obligación |
|---|---|
| Operador | Proponer pasos, destino, ventana y límites; revisar simulación; supervisar ejecución |
| Revisor independiente | Revisar el cambio, su alcance y el respaldo; aprobar en GitHub |
| Administrador de datos | Preparar credenciales, validar RLS, mantener backups y ensayar restauraciones |
| Responsable del servicio | Atender alertas y autorizar recuperación ante resultados inciertos |

Configurar **Settings → Environments**:

- `maintenance-scan`: `SUPABASE_URL`, `SUPABASE_READ_KEY`, opcional `TMDB_API_KEY`.
- `production-maintenance`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, opcional `TMDB_API_KEY`. Configurar **required reviewers**, **prevent self-review**, restricción a la rama por defecto y, cuando esté disponible, impedir bypass administrativo.
- No dejar la service-role como secret global del repositorio u organización accesible a jobs no protegidos. Moverla al entorno protegido y revisar sus accesos.
- Proteger también la rama por defecto: PR obligatorio, al menos un revisor independiente, checks de CI obligatorios y sin push directo. Estas reglas **no se crean automáticamente** al añadir los YAML. Su disponibilidad depende del plan/visibilidad de GitHub.
- Mantener los logs y artefactos operativos en un repositorio privado con acceso limitado. Si se usa un repositorio público, adaptar la exportación de auditoría a almacenamiento privado **antes de conectar producción**.

### Credencial de lectura

`SUPABASE_READ_KEY` debe ser un token válido para la API de Supabase asociado a un rol con **SELECT, sin INSERT/UPDATE/DELETE ni acceso a RPCs que escriban**. No equivale necesariamente a la clave `anon` o `publishable`; sus permisos dependen de grants/RLS. Un administrador debe aprovisionarla según la configuración de autenticación del proyecto.

En staging, verificar que:

1. Puede leer y contar **todas las filas relevantes**; comparar con un conteo SQL autorizado. Un token con visibilidad parcial produce un análisis incompleto.
2. INSERT, UPDATE, DELETE y RPCs de escritura se rechazan usando esa credencial y datos de prueba. Un HTTP exitoso que afecte cero filas por RLS no demuestra que el rol carezca de permisos: revisar también grants/policies.
3. No es una service-role renombrada. La aplicación separa qué variable utiliza, pero no puede certificar sus privilegios reales.

La service-role de aplicación tiene privilegios amplios y puede saltarse RLS. Guardarla exclusivamente como secreto protegido, rotarla y nunca entregarla al navegador, a forks o a jobs de PR.

## 2. Flujo de cambio

1. **Staging:** usar un proyecto independiente con datos representativos. Aplicar allí las migraciones revisadas, no sobre producción automáticamente.
2. **CI:** `npm ci --ignore-scripts`, `npm test`, `npm audit --omit=dev --audit-level=high`. La matriz comprueba Node 22/24. Dependabot propone cambios de dependencias/Actions que también deben revisarse.
3. **Analizar:** ejecutar el workflow de análisis o `npm run local:dry`. La programación diaria **nunca aplica cambios**. Revisar resultados, exclusiones y límites. Si el análisis del workflow concluye sin errores, su resumen incluye un enlace para iniciar manualmente el workflow protegido de aplicación; no lo ejecuta ni transfiere una autorización. Para inspeccionar títulos usar `LOG_SAMPLES=true` únicamente en un entorno autorizado.
4. **Respaldar:** verificar backup o PITR y ensayar una restauración en otro proyecto. Definir RPO/RTO con el dueño del servicio, no asumirlos. Registrar una referencia no secreta en el ticket.
5. **Autorizar:** ticket con proyecto/tabla, commit, pasos, conteos esperados, ratio, tope absoluto, ventana, responsable, evidencia del análisis y plan de recuperación. No pegar claves ni URLs firmadas.
6. **Aplicar:** workflow manual desde la rama por defecto. Exige `APPLY:<tabla>`, ticket, referencia de respaldo y pasos explícitos; el entorno exige al revisor cuando esté configurado. El porcentaje por defecto es 10 % y el máximo absoluto 1000 filas por ejecución; se aplica el menor.
7. **Verificar:** revisar `run.end`, todos los recibos, conteos finales, disponibilidad del addon y errores. No tratar un job rojo como éxito parcial aceptado sin revisar qué se confirmó.

`BACKUP_REFERENCE` y `CHANGE_TICKET` son referencias declaradas por el operador: **el programa no consulta el sistema de tickets ni verifica el backup**. La aprobación autoriza una ejecución, no un plan inmutable: los candidatos se recalculan al aplicar. La simulación no materializa las actualizaciones de normalización/enriquecimiento y por eso puede diferir de la ejecución real. Para limitar diferencias, usar una ventana sin escrituras externas y cambios pequeños, preferiblemente un paso cada vez.

La política de otros idiomas es `keep` por defecto. `delete` requiere una decisión de negocio explícita. Un resultado ambiguo no debe resolverse aumentando límites sin revisión.

## 3. Auditoría y privacidad

Cada ejecución genera `audit/<UUID>.jsonl` con permisos `0600`. La carpeta nueva se crea con `0700`; si ya existe, el operador debe revisar sus permisos y propietario. Cada línea contiene versión de esquema, UUID, secuencia y hora UTC.

- `run.start`: destino, modo, commit/actor de GitHub si están disponibles, pasos, límites y referencias operativas. El actor local es `local`, no una identidad autenticada.
- `step.start` / `step.end`: estado y métricas de cada paso.
- `delete.plan`: conteo de candidatos, presupuesto disponible y si lo permite. No es una lista firmada de candidatos para aplicar posteriormente.
- `mutation.intent`: UUID de operación, tipo, tabla, motivo, **IDs candidatos** y nombres de columnas afectadas, sin valores de patches ni títulos. Se fuerza a disco antes de enviar la petición.
- `mutation.result`: mismo UUID, `confirmed`, `rejected` o `unknown`, y conteo cuando es conocido. El conteo puede ser menor al número de IDs candidatos por los filtros de concurrencia; no identifica exactamente qué subconjunto cambió.
- `run.end`: estado final y conteos. Un archivo sin cierre puede indicar interrupción o caída; **no equivale a éxito**.

El diario no contiene las filas anteriores: **no permite restaurar datos por sí solo**. No es inmutable, no está firmado ni se escribe en una transacción conjunta con Supabase. GitHub conserva artefactos durante 30 días; su subida se intenta incluso tras un fallo, pero un runner perdido o un fallo de subida puede impedir conservarlos. Para requisitos de cumplimiento, exportar a almacenamiento restringido/inmutable con una retención definida y probar ese proceso.

Los secretos conocidos del entorno, bearer tokens y parámetros habituales de API se redactan. La redacción es defensa adicional, no permiso para imprimir datos sensibles: no introducir secretos en tickets/referencias, no activar DEBUG por defecto, revisar los logs antes de compartirlos. Los proveedores externos de enriquecimiento reciben títulos de búsqueda; `DRY_RUN` no evita esas llamadas. Omitir `enrich` cuando la política de datos no lo permita.

## 4. Fallos, interrupciones y recuperación

- Un fallo de paso o errores registrados de enriquecimiento/normalización bloquean los pasos siguientes. No hay rollback global.
- Un fallo al persistir auditoría impide **nuevas** escrituras. Algunas peticiones concurrentes pueden estar ya enviadas y completarse.
- Un timeout de escritura o respuesta sin conteo puede ocultar un commit. No reintentar automáticamente. Los UPDATE solo aíslan filas tras errores SQL de integridad clase `23`, que indican rechazo de esa sentencia. Los DELETE no se reintentan desde la aplicación.
- Cancelar el workflow o matar el proceso no garantiza cancelar/rehacer sentencias ya enviadas al servidor. Una `mutation.intent` sin recibo o con `unknown` exige reconciliación.

**Procedimiento ante incidente:**

1. Detener nuevas ejecuciones y pausar los escritores externos. Guardar logs, UUID de ejecución y commit; no aumentar límites para forzar continuidad.
2. Correlacionar intenciones y recibos por `operationId`. Consultar el estado actual de los IDs afectados y logs de la base de datos; no asumir que una respuesta perdida significa que no se escribió.
3. Si hay borrados incorrectos, restaurar el backup/PITR **en un proyecto separado**. Comparar y decidir una recuperación selectiva con el administrador; evitar sobreescribir cambios legítimos posteriores con una restauración a ciegas.
4. Verificar restricciones, secuencias, IDs y disponibilidad del addon. Registrar pérdidas/diferencias y evidencia del incidente.
5. Corregir la causa, añadir una regresión, volver a simular y obtener otra aprobación antes de reanudar.

## 5. Límites que deben conocerse

- `concurrency` coordina ambos workflows en este repositorio. No es un bloqueo distribuido entre máquinas, ejecuciones locales, otros repositorios o scrapers. Designar un único ejecutor y una ventana de mantenimiento.
- El escaneo por páginas no es una instantánea transaccional. El borrado por adulto/deduplicación no revalida todos los cambios concurrentes de título/IDs. No ejecutar esos pasos mientras los scrapers escriben si se requiere evitar esa carrera.
- Las heurísticas de contenido, idioma y tamaño pueden equivocarse. No son un criterio legal ni una política empresarial completa.
- La auditoría durable añade I/O por lote. Monitorizar espacio en disco; la falta de espacio debe detener la ejecución, no desactivar la auditoría.
- Las pruebas automatizadas usan datos simulados, incluido el cliente Supabase con transporte simulado. **No sustituyen pruebas de grants/RLS, triggers, límites de PostgREST, restauración ni concurrencia en staging.**

## 6. Migración desde la versión anterior

- La tarea diaria cambia de aplicación real a **análisis**.
- La simulación ahora necesita `SUPABASE_READ_KEY`; ya no usa la service-role ni `SUPABASE_KEY` como fallback.
- `DRY_RUN=false` por sí solo ya no autoriza escrituras.
- Los defaults de borrado pasan a 10 %, 1000 filas y conservar otros idiomas.
- Un fallo detiene el resto del pipeline, en lugar de continuar con pasos dependientes.
- Un operador debe configurar los entornos, políticas de aprobación, secretos y respaldos antes de habilitar producción. Estos cambios de infraestructura no se han aplicado automáticamente.
