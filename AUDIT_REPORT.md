# Auditoría inicial — YLMA SPHEREx Explorer

Fecha: 2026-11-14  
Rama auditada: `copilot/audit-repair-spherex-explorer`  
Base de referencia: `main` (commit `467c568c24239e1d9f074c2d08d1d8a52ed9abc5`)

## Estado general

El repositorio contiene una UI estática con Aladin Lite, una API FastAPI, persistencia SQLAlchemy y archivos JSON para demo/cuestionario. La interfaz se presenta como un explorador de observaciones, pero la consulta científica era placeholder; además generaba épocas y URL FITS que no se correspondían con registros consultados. La configuración previa de Render servía el frontend desde FastAPI, pero tenía orígenes CORS heredados y no expresaba explícitamente el modo demo ni la configuración de IRSA.

No se debe considerar el proyecto listo para producción hasta ejecutar las pruebas en un entorno con dependencias instaladas, configurar PostgreSQL y confirmar el esquema actual del TAP de IRSA en tiempo de ejecución.

## Arquitectura actual

- Frontend: HTML/CSS/JavaScript estático, servido por FastAPI en Render; Aladin Lite v3 se carga desde CDS.
- Backend: FastAPI, servicios separados para SPHEREx/IRSA, preguntas y estadísticas.
- Persistencia: SQLAlchemy; SQLite local como valor por defecto y PostgreSQL posible mediante `DATABASE_URL` y psycopg.
- Ciencia: TAP sync de IRSA/IPAC esperado en `https://irsa.ipac.caltech.edu/TAP/sync`.
- Configuración de despliegue: Render Blueprint en la raíz y un único servicio web.

## Funcionalidades y hallazgos

| Severidad | Área | Hallazgo / corrección prevista |
|---|---|---|
| CRÍTICA | IRSA/TAP | Se consultaba `spherex_tbl` con ADQL constante, sin validar tablas/columnas. Sustituir por descubrimiento de `TAP_SCHEMA` y consultar solo tablas con coordenadas compatibles, manejando respuestas y errores explícitamente. |
| CRÍTICA | Integridad científica | El fallback demo modificaba las coordenadas de observaciones estáticas y podía presentarlas como reales. Demo debe estar desactivado por defecto y solo activarse explícitamente, con `is_demo` y fuente visibles. |
| CRÍTICA | Frontend | La línea temporal fabricaba fechas, nombres FITS y rutas de archivo. La UI debe basarse en observaciones reales recibidas; sin resultados, no inventar observaciones ni indicar que hay fuentes detectadas. |
| ALTA | Detalles | El detalle no resolvía IDs del archivo y devolvía el primer registro demo como fallback. Debe buscar por identificador real y responder 404 si no existe. |
| ALTA | Validación | Las coordenadas, radios y límites deben validarse y acotarse en API y esquemas. |
| ALTA | Resiliencia | Añadir timeout configurable, reintentos limitados, parsing explícito y logs; no silenciar errores externos ni convertirlos en resultados científicos. |
| ALTA | Estadísticas | Métricas agregadas incluían constantes ficticias. Deben derivarse únicamente de la base persistida y marcarse como no demo. |
| ALTA | Seguridad | CORS comodín no es apropiado en producción. Limitar a orígenes configurados y usar un límite básico de peticiones; para escalado multiinstancia, usar un rate limiter compartido. |
| ALTA | Despliegue | El frontend usaba `127.0.0.1:8000`, incompatible con el servicio Render. Usar rutas relativas cuando UI y API se sirven en el mismo origen. |
| MEDIA | Base de datos | SQLite no es apropiado para persistencia durable en Render. Configurar `DATABASE_URL` de PostgreSQL; normalizar URL de Render a psycopg 3 y activar `pool_pre_ping`. |
| MEDIA | Observabilidad | Health check básico y errores poco diferenciados. Añadir registro de errores de integración y respuesta de estado de fuente; revisar logs/health en Render. |
| MEDIA | Cuestionario/modelos | `QuestionModel` no se usa; preguntas viven en JSON. Mantener el comportamiento sin migrar la funcionalidad en esta intervención. |
| BAJA | Documentación | Hay afirmaciones de roadmap y capacidades no verificadas; actualizar tras validar en el entorno de despliegue. |
| BAJA | Higiene | Nombre del archivo de licencia está mal escrito como `LISCENSE.txt`. No se modifica para evitar cambios fuera del alcance. |

## Endpoints

- `GET /api/health`: implementado; comprobar conexión de DB por separado antes de producción.
- `GET /api/config`: implementado, pero anteriormente reportaba demo activo fijo.
- `GET /api/observations`: antes no era fiable (tabla placeholder y fallback oculto); debe reportar metadatos de fuente/modo real y límites.
- `GET /api/observation/{obs_id}`: antes no resolvía productos reales ni distinguía un miss.
- `GET /api/questions`, `POST /api/user`, `GET /api/user/{id}/progress`, `POST /api/answers`: funcionalidades locales existentes; validar solicitudes y errores.
- `GET /api/stats`: antes devolvía cifras inventadas; usar agregados reales.

## Integraciones externas

- IRSA/IPAC TAP: endpoint configurado; no se presupone el nombre de una tabla. Consultar `TAP_SCHEMA.tables` y `TAP_SCHEMA.columns` en ejecución y registrar errores/tiempos.
- Aladin Lite/CDS: atlas de cielo externo. No asumir que una URL FITS de IRSA se visualiza correctamente en Aladin sin comprobar el registro y la compatibilidad.
- Gaia/SIMBAD: no están implementados en el backend; no se presentan como fuentes alternativas.

## Base de datos, frontend y rendimiento

La base local SQLite puede perder durabilidad en servicios efímeros. En producción, definir `DATABASE_URL` con una base gestionada. El frontend debe eliminar consultas a localhost, impedir XSS al renderizar metadatos (usar nodos/textContent), no lanzar llamadas en cada frame del slider y no cargar archivos inventados. La caché, cancelación de peticiones y tamaño de respuestas deben mantenerse acotados.

## Riesgos y plan de corrección

1. No devolver datos demo salvo configuración explícita; incluir marcador de demo en toda respuesta.
2. Descubrir el esquema TAP y formar ADQL desde columnas verificadas; limitar resultados y validar coordenadas.
3. Buscar detalles por ID real, con errores HTTP claros.
4. Mostrar en la UI estados cargando, vacío, error, real o demo; usar observaciones reales para split/blink.
5. Endurecer CORS, configuración, DB URL y límites de API para el despliegue Render.
6. Ejecutar pruebas automatizadas y una prueba de humo contra IRSA/Render antes de desplegar.

## Límites de esta auditoría

La revisión inicial se basa en los archivos del repositorio y no equivale a una prueba en producción. La disponibilidad y el esquema TAP son cambiantes: la aplicación debe verificarlos en runtime. No se debe afirmar que la API externa ni el despliegue han sido probados hasta correr las verificaciones correspondientes.
