# YLMA SPHEREx Explorer

## 1. Presentación e Identificación del Equipo
* **Equipo:** YLMA Space
* **Proyecto:** YLMA SPHEREx Explorer
* **Desafío:** Planet X and SPHEREx - NASA Space Apps Challenge 2026
* **Integrantes y Autores:** Jorge López Susín y Equipo YLMA Space
* **Organización:** YLMA Space Official (`ylmaspace`)

---

## 2. Descripción del Proyecto y Propósito
YLMA SPHEREx Explorer es un entorno interactivo de análisis astrofísico diseñado para visualizar, consultar y correlacionar datos espectrofotométricos de infrarrojo cercano provenientes de la misión SPHEREx (Spectro-Photometer for the History of the Universe, Epoch of Reionization, and Ices Explorer) de la NASA.

La plataforma permite a la comunidad investigadora y entusiastas del espacio explorar datos de fuentes astronómicas en función de coordenadas astronómicas (Ascensión Recta y Declinación), épocas temporales y capas espectrales, combinando motores de renderizado celeste con servicios backend en tiempo real.

---

## 3. Estado Actual de la Arquitectura
El proyecto consta de una arquitectura desacoplada basada en microservicios backend y una interfaz cliente basada en tecnologías web nubes.

### 3.1. Componentes Actuales
1. **Backend (Python / FastAPI):**
   * Puntos de entrada REST API para la gestión de usuarios, consultas de observación y preguntas educativas/evaluativas (`/api/observations`, `/api/questions`, `/api/answers`, `/api/stats`).
   * Capa de persistencia relacional con SQLAlchemy (`spherex.db`).
   * Módulos de servicios integrados (`spherex.py`, `irsa.py`, `questions.py`, `statistics.py`).

2. **Frontend (HTML5 / CSS3 / JavaScript ES6+):**
   * Panel de control con diseño espacial e interfaz adaptada a la marca YLMA Space.
   * Sistema de visualización incrustado y sincronización de fechas/épocas de observación mediante un selector deslizante de línea temporal.
   * Modales dinámicos para el listado e inspección de datos de objetos observados en coordenadas e intervalo de tiempo seleccionados.

---

## 4. Integración de Datos Científicos y Enlaces de Interés

### 4.1. Recursos de Misión SPHEREx
* **Desafío Oficial NASA Space Apps:** [Planet X and SPHEREx Challenge](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/)
* **JPL SPHEREx Mission:** [NASA JPL SPHEREx](https://www.jpl.nasa.gov/missions/spherex/)
* **Caltech SPHEREx Center:** [Caltech Science Center](https://spherex.caltech.edu/)
* **IRSA Data Access:** [IRSA SPHEREx Landing](https://irsa.ipac.caltech.edu/Missions/spherex.html)
* **Acceso Directo a FITS Level 2:** [IRSA IBE Cloud Level 2 Data](https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2)
* **Application MOST (Object Search):** [IRSA MOST Service](https://irsa.ipac.caltech.edu/applications/MOST/)

### 4.2. Visores y Catálogos Auxiliares
* **Aladin Lite API (CDS Unistra):** [Aladin Lite API Reference](https://cds-astro.github.io/aladin-lite/)
* **Aladin Lite Finding Chart Tutorial:** [Aladin Lite Interactive Chart](https://aladin.cds.unistra.fr/AladinLite/doc/tutorials/interactive-finding-chart/)
* **ESA Gaia DR3 Catalog:** [Gaia Data Release 3 Repository](https://cdn.gea.esac.esa.int/?prefix=Gaia/gdr3/)
* **SIMBAD Astronomical Database:** Servicios de resolución astronómica por nombres y coordenadas para capas de soporte.

---

## 5. Plan de Mejoras, Fallos Identificados y Correcciones en Desarrollo

A pesar de contar con la estructura base funcional, se han identificado limitaciones arquitectónicas e imprecisiones de renderizado que están siendo corregidas para la versión final de la competición.

### 5.1. Fallos y Limitaciones Detectadas
1. **Dependencia de Marcos Externos Static (Iframe vs API Nativa):**
   * *Problema:* La versión actual utiliza un contenedor iframe genérico, lo que impide la superposición nativa de mapas HiPS o archivos FITS generados dinámicamente por la API del IBE.
   * *Solución:* Migración hacia el cliente nativo Javascript **Aladin Lite API**, inicializando el visor dentro de un contenedor `div` para renderizar mosaicos astronómicos directamente desde el servidor IBE.

2. **Carga Descendente de Archivos FITS Gráficos:**
   * *Problema:* El procesamiento local de imágenes FITS voluminosas del nivel 2 de SPHEREx causa saturación de memoria en el navegador.
   * *Solución:* Adoptar consultas por URL remotas (punteros a la nube del Caltech IPAC) en lugar de descarga física de archivos localmente, delegando el mosaico a Aladin Lite o procesándolos previamente en el backend vía `astropy`.

3. **Latencia y Mecanismo de Tolerancia a Fallos (Fallback Data):**
   * *Problema:* Cuando el servidor IBE o la API de SPHEREx demora la respuesta, la vista pierde el contexto de las fuentes detectadas.
   * *Solución:* Implementar un sistema jerárquico de peticiones donde, en caso de timeout en la API de SPHEREx, el sistema cargue datos complementarios del catálogo **Gaia DR3** o **SIMBAD** como capa de reserva.

4. **Traducción y Estandarización de Etiquetas Metadata AVM:**
   * *Problema:* Ausencia de mapeo automático de metadatos AVM (Astronomy Visualization Metadata) en las capturas astronómicas.
   * *Solución:* Integrar en el motor de respuesta FastAPI la extracción de encabezados FITS y tags AVM para mostrar la orientación, escala cromática e instrumental real.

---

## 6. Guía de Instalación y Despliegue Local

### 6.1. Requisitos Previos
* Python 3.10 o superior
* Git
* Navegador moderno compatible con WebGL / HTML5 Canvas

### 6.2. Ejecución del Backend
```bash
cd spherex-project

# Crear y activar entorno virtual (opcional pero recomendado)
python -m venv venv
# En Windows:
venv\Scripts\activate
# En Linux/macOS:
source venv/bin/activate

# Instalar dependencias necesarias
pip install -r backend/requirements.txt

# Iniciar servidor Uvicorn FastAPI
uvicorn backend.main:app --reload --port 8000
```

### 6.3. Ejecución del Frontend
1. Abrir la carpeta `frontend/` en cualquier servidor web local o mediante la extensión Live Server de VS Code.
2. Abrir `index.html` en el navegador. La aplicación se conectará automáticamente al endpoint de API en `http://127.0.0.1:8000`.

---

## 7. Hoja de Ruta (Roadmap)
- [x] Estructuración del repositorio y control de versiones Git/GitHub.
- [x] Configuración de endpoints REST con FastAPI y modelo SQLAlchemy.
- [x] Implementación de prototipo de interfaz UI/UX YLMA Space.
- [ ] Sustitución del visor Iframe por **Aladin Lite API v3** en JavaScript.
- [ ] Conexión directa del backend con el servicio TAP e IBE de IRSA/Caltech para imágenes FITS Nivel 2.
- [ ] Integración de respaldo dinámico con Gaia DR3 / SIMBAD.
- [ ] Despliegue en la nube y preparación del video de demostración para el panel de evaluadores de NASA Space Apps.
