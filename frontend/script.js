// YLMA SPHEREx Explorer — same-origin API and archive-backed observations only.
let aladin = null;
let aladinLeft = null;
let aladinRight = null;
let isSplitMode = false;
let blinkInterval = null;
let isBlinkingActive = false;
let observations = [];
let catalogEntries = [];
let requestController = null;
let activeLocalFitsUrl = null;
let comparisonLocalFitsUrl = null;
let comparisonLocalFitsName = '';
let pendingLocalCompareMode = null;
let blinkLocalShowingSecond = false;
let fitsLoadToken = 0;
let skyMarkerLayer = null;
let skyMarkerSources = [];
let skyMarkersLoaded = false;
let savedSkyRecords = [];
let localFitsZoom = 1;
let localFitsPan = { x: 0, y: 0 };
let localFitsDrag = null;
const SKY_DB_NAME = 'ylma-spherex-atlas';
let state = {
    userId: localStorage.getItem('ylma_user_id') || 'YLMA-USER-2026',
    currentRA: 150.1,
    currentDec: 2.2,
    currentRadius: 2,
    currentIndex: 0,
    splitIndexLeft: 0,
    splitIndexRight: 0
};

const byId = (id) => document.getElementById(id);
const API = '';

document.addEventListener('DOMContentLoaded', () => {
    initUser();
    setupEventListeners();
    setObservationStatus('Listo para consultar IRSA.');
    loadSavedSkyMap();
    initLocalFitsControls();
});

function initUser() {
    const badge = byId('user-session-badge');
    if (badge) badge.textContent = state.userId;
}

function setObservationStatus(message, count = '') {
    if (byId('info-status')) byId('info-status').textContent = message;
    if (byId('info-count')) byId('info-count').textContent = count;
}

function setupEventListeners() {
    byId('explore-btn')?.addEventListener('click', async () => {
        byId('landing-view').classList.remove('active');
        byId('explorer-view').classList.add('active');
        await initAladinViewer();
        await searchObservations();
    });
    byId('back-home')?.addEventListener('click', () => {
        byId('explorer-view').classList.remove('active');
        byId('landing-view').classList.add('active');
    });
    byId('catalog-search-btn')?.addEventListener('click', loadCatalog);
    byId('catalog-path')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') loadCatalog(); });
    byId('catalog-up-btn')?.addEventListener('click', () => {
        const input = byId('catalog-path');
        if (!input) return;
        const value = input.value.trim();
        try {
            const url = new URL(value);
            const root = '/ibe/data/spherex/';
            if (url.hostname === 'irsa.ipac.caltech.edu' && url.pathname.startsWith(root)) {
                const parts = url.pathname.slice(root.length).split('/').filter(Boolean);
                parts.pop();
                input.value = root + (parts.length ? parts.join('/') + '/' : '');
            } else {
                const parts = value.split('/').filter(Boolean);
                parts.pop();
                input.value = parts.join('/');
            }
        } catch {
            const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
            parts.pop();
            input.value = parts.join('/');
        }
        loadCatalog();
    });
    byId('select-fits-btn')?.addEventListener('click', () => byId('local-fits-input')?.click());
    byId('load-fits-url-btn')?.addEventListener('click', loadFitsFromUrl);
    byId('fits-url-input')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); loadFitsFromUrl(); } });
    byId('compare-fits-btn')?.addEventListener('click', () => byId('compare-fits-input')?.click());
    byId('blink-compare-upload')?.addEventListener('click', () => byId('compare-fits-input')?.click());
    byId('split-compare-upload')?.addEventListener('click', () => byId('compare-fits-input')?.click());
    byId('compare-fits-input')?.addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) await loadComparisonFits(file);
    });
    byId('fits-drop-button')?.addEventListener('click', (event) => {
        event.stopPropagation();
        byId('local-fits-input')?.click();
    });
    byId('fits-dropzone')?.addEventListener('click', (event) => {
        if (event.target.closest('button')) return;
        byId('local-fits-input')?.click();
    });
    byId('fits-dropzone')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); byId('local-fits-input')?.click(); }
    });
    byId('local-fits-input')?.addEventListener('change', (event) => {
        if (event.target.files?.length) loadLocalFitsBatch(Array.from(event.target.files));
        event.target.value = '';
    });
    const dropzone = byId('fits-dropzone');
    ['dragenter', 'dragover'].forEach((name) => dropzone?.addEventListener(name, (event) => {
        event.preventDefault(); dropzone.classList.add('drag-active');
    }));
    ['dragleave', 'drop'].forEach((name) => dropzone?.addEventListener(name, (event) => {
        event.preventDefault(); dropzone.classList.remove('drag-active');
    }));
    dropzone?.addEventListener('drop', (event) => {
        const files = Array.from(event.dataTransfer?.files || []);
        if (files.length) loadLocalFitsBatch(files);
    });
    byId('catalog-query')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') loadCatalog(); });
    byId('catalog-path')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') loadCatalog(); });
    byId('search-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        state.currentRA = Number(byId('input-ra').value);
        state.currentDec = Number(byId('input-dec').value);
        state.currentRadius = Number(byId('input-radius').value);
        if (!Number.isFinite(state.currentRA) || state.currentRA < 0 || state.currentRA > 360 ||
            !Number.isFinite(state.currentDec) || state.currentDec < -90 || state.currentDec > 90 ||
            !Number.isFinite(state.currentRadius) || state.currentRadius <= 0 || state.currentRadius > 10) {
            setObservationStatus('Coordenadas o radio fuera de rango (RA 0–360°, Dec −90–90°, radio >0–10°).', '');
            return;
        }
        await initAladinViewer();
        await searchObservations();
    });
    byId('layer-real')?.addEventListener('click', () => {
        setActiveLayer('layer-real');
        if (aladin) aladin.setImageSurvey('P/DSS2/color');
    });
    byId('layer-fits')?.addEventListener('click', () => {
        setActiveLayer('layer-fits');
        showSelectedObservation();
    });
    byId('btn-split')?.addEventListener('click', toggleSplitView);
    byId('btn-blink')?.addEventListener('click', () => byId('blink-modal').classList.add('active'));
    byId('blink-close-btn')?.addEventListener('click', () => {
        byId('blink-modal').classList.remove('active');
        stopBlink();
    });
    byId('blink-start-toggle')?.addEventListener('click', toggleBlink);
    byId('btn-fs')?.addEventListener('click', toggleFullscreen);
    byId('nav-objects-btn')?.addEventListener('click', () => {
        byId('objects-modal').classList.add('active');
        renderObservationList();
    });
    byId('objects-close-btn')?.addEventListener('click', () => byId('objects-modal').classList.remove('active'));
    byId('epoch-index')?.addEventListener('change', (event) => {
        const index = parseObservationIndex(event.target.value);
        if (index === null) { event.target.value = observations.length ? String(state.currentIndex + 1) : ''; return; }
        state.currentIndex = index;
        event.target.value = String(index + 1);
        showSelectedObservation();
    });
    byId('split-index-left')?.addEventListener('change', (event) => {
        const index = parseObservationIndex(event.target.value);
        if (index === null) { event.target.value = String(state.splitIndexLeft + 1); return; }
        state.splitIndexLeft = index;
        event.target.value = String(index + 1);
        updateSplitPane('left', index);
    });
    byId('split-index-right')?.addEventListener('change', (event) => {
        const index = parseObservationIndex(event.target.value);
        if (index === null) { event.target.value = String(state.splitIndexRight + 1); return; }
        state.splitIndexRight = index;
        event.target.value = String(index + 1);
        updateSplitPane('right', index);
    });
}

function applyLocalFitsTransform() {
    const image = byId('fits-local-image');
    if (image) image.style.transform = 'translate(' + localFitsPan.x + 'px, ' + localFitsPan.y + 'px) scale(' + localFitsZoom + ')';
}
function initLocalFitsControls() {
    const viewport = byId('fits-local-viewport'); const image = byId('fits-local-image');
    byId('fits-local-reset')?.addEventListener('click', () => { localFitsZoom = 1; localFitsPan = {x:0,y:0}; applyLocalFitsTransform(); });
    viewport?.addEventListener('wheel', (event) => { event.preventDefault(); localFitsZoom = Math.max(.25, Math.min(12, localFitsZoom * (event.deltaY < 0 ? 1.15 : 1/1.15))); applyLocalFitsTransform(); }, {passive:false});
    viewport?.addEventListener('pointerdown', (event) => { if (event.target !== image) return; localFitsDrag = {x:event.clientX-localFitsPan.x,y:event.clientY-localFitsPan.y}; viewport.setPointerCapture(event.pointerId); });
    viewport?.addEventListener('pointermove', (event) => { if (!localFitsDrag) return; localFitsPan = {x:event.clientX-localFitsDrag.x,y:event.clientY-localFitsDrag.y}; applyLocalFitsTransform(); });
    const stop = () => {localFitsDrag = null;}; viewport?.addEventListener('pointerup',stop); viewport?.addEventListener('pointercancel',stop);
}
function openSkyDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(SKY_DB_NAME, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('No se pudo abrir el almacenamiento local.'));
    });
}

async function getSavedSkyRecords() {
    const db = await openSkyDatabase();
    return new Promise((resolve, reject) => {
        const request = db.transaction('images', 'readonly').objectStore('images').getAll();
        request.onsuccess = () => { db.close(); resolve(request.result || []); };
        request.onerror = () => { db.close(); reject(request.error); };
    });
}

async function saveSkyRecord(record) {
    const db = await openSkyDatabase();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('images', 'readwrite');
        tx.objectStore('images').put(record);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

async function deleteSkyRecord(id) {
    const db = await openSkyDatabase();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('images', 'readwrite');
        tx.objectStore('images').delete(id);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

function showFitsProgress(title, message, percent = 0) {
    const overlay = byId('fits-progress-overlay');
    if (!overlay) return;
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
    if (byId('fits-progress-title')) byId('fits-progress-title').textContent = title;
    if (byId('fits-progress-message')) byId('fits-progress-message').textContent = message;
    if (byId('fits-progress-bar')) byId('fits-progress-bar').style.width = `${percent}%`;
    if (byId('fits-progress-percent')) byId('fits-progress-percent').textContent = `${Math.round(percent)}%`;
}

function hideFitsProgress() {
    const overlay = byId('fits-progress-overlay');
    overlay?.classList.remove('active');
    overlay?.setAttribute('aria-hidden', 'true');
}

function renderSavedSkyMap() {
    const list = byId('saved-sky-list');
    if (!list) return;
    list.replaceChildren();
    if (byId('saved-sky-summary')) byId('saved-sky-summary').textContent =
        `${savedSkyRecords.length} imagen(es) incorporadas al mapa`;
    if (!savedSkyRecords.length) {
        const empty = document.createElement('p');
        empty.className = 'doc-text';
        empty.textContent = 'Todavía no has guardado imágenes.';
        list.appendChild(empty);
        return;
    }
    savedSkyRecords.forEach((record) => {
        const card = document.createElement('div');
        card.className = 'saved-sky-item';
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'saved-sky-open';
        const title = document.createElement('strong');
        title.textContent = record.filename;
        const coords = document.createElement('span');
        coords.textContent = record.ra !== null && record.dec !== null && Number.isFinite(Number(record.ra)) && Number.isFinite(Number(record.dec)) ? `RA ${Number(record.ra).toFixed(5)}° · Dec ${Number(record.dec).toFixed(5)}°` : 'WCS no incluido';
        open.append(title, coords);
        open.addEventListener('click', () => {
            if (record.file) loadLocalFits(record.file, record.id);
            else setObservationStatus('El archivo original no está disponible en este navegador.', '');
        });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'QUITAR DEL MAPA';
        remove.addEventListener('click', async () => {
            await deleteSkyRecord(record.id);
            savedSkyRecords = savedSkyRecords.filter((item) => item.id !== record.id);
            renderSavedSkyMap();
            rebuildSkyMarkers();
        });
        card.append(open, remove);
        list.appendChild(card);
    });
}

async function loadSavedSkyMap() {
    try {
        savedSkyRecords = await getSavedSkyRecords();
        renderSavedSkyMap();
        rebuildSkyMarkers();
    } catch (error) {
        console.warn('IndexedDB unavailable', error);
        setObservationStatus('El navegador no permite guardar el mapa celeste localmente.', '');
    }
}

function rebuildSkyMarkers() {
    if (!aladin || !window.A?.catalog || !window.A?.marker) return;
    if (!skyMarkerLayer) {
        skyMarkerLayer = A.catalog({ name: 'YLMA · Mis imágenes FITS', shape: 'cross', color: '#ffb700', sourceSize: 13 });
        aladin.addCatalog(skyMarkerLayer);
    }
    skyMarkerSources.forEach((source) => {
        try { skyMarkerLayer.remove(source); } catch (_) {}
    });
    skyMarkerSources = [];
    savedSkyRecords.filter((record) => record.ra !== null && record.dec !== null && Number.isFinite(Number(record.ra)) && Number.isFinite(Number(record.dec))).forEach((record) => {
        const marker = A.marker(Number(record.ra), Number(record.dec), {
            popupTitle: String(record.filename).slice(0, 150),
            popupDesc: `RA: ${Number(record.ra).toFixed(6)}°<br>Dec: ${Number(record.dec).toFixed(6)}°<br>HDU: ${Number(record.hdu_index)}`
        });
        skyMarkerSources.push(marker);
        skyMarkerLayer.addSources(marker);
    });
    skyMarkersLoaded = true;
}

async function uploadFitsToBackend(file, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/fits/upload');
        xhr.timeout = 8 * 60 * 1000;
        xhr.responseType = 'json';
        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) onProgress(Math.min(78, event.loaded / event.total * 78));
        };
        xhr.upload.onload = () => onProgress(80);
        xhr.onload = () => {
            let payload = xhr.response;
            if (!payload || typeof payload !== 'object') {
                try { payload = JSON.parse(xhr.responseText || '{}'); } catch (_) { payload = {}; }
            }
            if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
            else reject(new Error(payload.detail || payload.message || `El servidor respondió HTTP ${xhr.status}.`));
        };
        xhr.onerror = () => reject(new Error('La conexión se interrumpió durante la subida. Comprueba la conexión y vuelve a intentarlo.'));
        xhr.ontimeout = () => reject(new Error('El servidor tardó más de 8 minutos en procesar el FITS. La carga se ha cancelado; prueba con un archivo más pequeño.'));
        xhr.onabort = () => reject(new Error('La carga del FITS se canceló.'));
        const form = new FormData();
        form.append('file', file, file.name || 'observation.fits');
        onProgress(2);
        xhr.send(form);
    });
}

async function loadFitsFromUrl() {
    const input = byId('fits-url-input');
    const rawUrl = String(input?.value || '').trim();
    if (!rawUrl) {
        setObservationStatus('Pega una URL directa de un archivo FITS de IRSA.', 'URL necesaria');
        input?.focus();
        return;
    }
    let source;
    try {
        source = new URL(rawUrl);
    } catch (_) {
        setObservationStatus('La URL no tiene un formato válido.', 'URL no válida');
        return;
    }
    if (source.protocol !== 'https:' || source.hostname !== 'irsa.ipac.caltech.edu' ||
        source.username || source.password || source.search || source.hash ||
        !source.pathname.startsWith('/ibe/data/spherex/') || !/\\.(fits?|fts)$/i.test(source.pathname)) {
        setObservationStatus('Solo se admiten enlaces HTTPS directos a archivos FITS del archivo SPHEREx de IRSA.', 'URL no admitida');
        return;
    }
    const filename = decodeURIComponent(source.pathname.split('/').pop() || 'spherex-observation.fits');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8 * 60 * 1000);
    try {
        showFitsProgress('RECUPERANDO FITS DESDE IRSA', filename, 5);
        setObservationStatus('Solicitando el archivo directamente a IRSA…', 'Descarga remota');
        const proxyUrl = '/api/product?' + new URLSearchParams({ url: source.href }).toString();
        const response = await fetch(proxyUrl, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) {
            let detail = 'IRSA respondió HTTP ' + response.status + '.';
            try { const payload = await response.json(); if (payload.detail) detail = payload.detail; } catch (_) {}
            throw new Error(detail);
        }
        const declaredSize = Number(response.headers.get('content-length') || 0);
        if (declaredSize > 120 * 1024 * 1024) throw new Error('El FITS supera el límite de 120 MB.');
        showFitsProgress('DESCARGANDO FITS DESDE IRSA', filename, 45);
        const blob = await response.blob();
        if (!blob.size) throw new Error('IRSA devolvió un archivo vacío.');
        if (blob.size > 120 * 1024 * 1024) throw new Error('El FITS supera el límite de 120 MB.');
        if (blob.type.includes('text/html')) throw new Error('IRSA devolvió una página web en lugar de un FITS.');
        showFitsProgress('PROCESANDO FITS REMOTO', filename + ' · ' + (blob.size / 1048576).toFixed(1) + ' MB', 78);
        const file = new File([blob], filename, { type: 'application/fits', lastModified: Date.now() });
        const loaded = await loadLocalFits(file);
        if (loaded) {
            setObservationStatus('FITS remoto incorporado correctamente: ' + filename, (blob.size / 1048576).toFixed(1) + ' MB · IRSA');
            if (input) input.value = source.href;
        }
    } catch (error) {
        hideFitsProgress();
        console.error('Remote FITS import failed', error);
        const message = error.name === 'AbortError' ? 'La descarga desde IRSA superó los 8 minutos y se canceló.' : error.message;
        setObservationStatus('No se pudo incorporar el FITS desde la URL: ' + message, 'Error de carga remota');
    } finally {
        clearTimeout(timeout);
    }
}

async function loadComparisonFits(file) {
    if (!activeLocalFitsUrl) {
        setObservationStatus('Primero incorpora la imagen FITS principal; después podrás cargar la segunda para compararlas.', '');
        return;
    }
    if (!/\.(fits?|fts)$/i.test(file.name || '') || !file.size || file.size > 120 * 1024 * 1024) {
        setObservationStatus('Selecciona un FITS válido de hasta 120 MB.', 'Archivo no válido');
        return;
    }
    try {
        showFitsProgress('CARGANDO SEGUNDA IMAGEN', 'Procesando ' + file.name + '…', 0);
        const result = await uploadFitsToBackend(file, (percent) => {
            showFitsProgress('SUBIENDO SEGUNDA IMAGEN', file.name, percent);
        });
        if (!result?.id || !result.preview_url) throw new Error('El servidor no devolvió una vista previa válida.');
        showFitsProgress('PREPARANDO COMPARACIÓN', 'Descargando la segunda imagen…', 90);
        const response = await fetch(result.preview_url, { cache: 'no-store' });
        if (!response.ok) throw new Error('La vista previa respondió HTTP ' + response.status + '.');
        const blob = await response.blob();
        if (!blob.type.startsWith('image/')) throw new Error('La vista previa recibida no es una imagen.');
        const nextUrl = URL.createObjectURL(blob);
        const probe = new Image();
        probe.src = nextUrl;
        if (probe.decode) await probe.decode();
        else await new Promise((resolve, reject) => { probe.onload = resolve; probe.onerror = reject; });
        if (comparisonLocalFitsUrl) URL.revokeObjectURL(comparisonLocalFitsUrl);
        comparisonLocalFitsUrl = nextUrl;
        comparisonLocalFitsName = file.name;
        blinkLocalShowingSecond = false;
        const controls = byId('compare-fits-btn');
        if (controls) controls.textContent = 'CAMBIAR FITS DE COMPARACIÓN';
        const blinkLabel = byId('blink-status-label');
        if (blinkLabel) blinkLabel.textContent = 'Imagen A: ' + (byId('fits-local-title')?.textContent || 'FITS principal');
        renderLocalSplitComparison();
        setObservationStatus('Segunda imagen lista para comparar: ' + file.name, result.width + '×' + result.height);
        showFitsProgress('COMPARACIÓN PREPARADA', 'Ya puedes usar Parpadear o Vista dividida.', 100);
        setTimeout(hideFitsProgress, 700);
        if (pendingLocalCompareMode === 'split') {
            pendingLocalCompareMode = null;
            if (!isSplitMode) toggleSplitView();
        }
    } catch (error) {
        hideFitsProgress();
        console.error('FITS comparison upload failed', error);
        setObservationStatus('No se pudo cargar la segunda imagen: ' + error.message, 'Error de comparación');
    }
}

function renderLocalSplitComparison() {
    const left = byId('split-local-left');
    const right = byId('split-local-right');
    const leftTitle = byId('split-local-left-title');
    const rightTitle = byId('split-local-right-title');
    if (!left || !right || !activeLocalFitsUrl || !comparisonLocalFitsUrl) return;
    left.src = activeLocalFitsUrl;
    right.src = comparisonLocalFitsUrl;
    if (leftTitle) leftTitle.textContent = byId('fits-local-title')?.textContent || 'FITS A';
    if (rightTitle) rightTitle.textContent = comparisonLocalFitsName || 'FITS B';
}

function updateSkyCoordinates(result) {
    const ra = Number(result.ra), dec = Number(result.dec);
    if (result.ra === null || result.ra === undefined || result.dec === null || result.dec === undefined || !Number.isFinite(ra) || !Number.isFinite(dec)) {
        if (byId('info-radec')) byId('info-radec').textContent = 'WCS no disponible en este FITS';
        return false;
    }
    state.currentRA = ra;
    state.currentDec = dec;
    const widthDeg = (Number(result.pixel_scale_arcsec) || 1) * Math.max(result.width, result.height) / 3600 * 1.25;
    state.currentRadius = Math.max(0.002, Math.min(10, widthDeg));
    if (byId('input-ra')) byId('input-ra').value = state.currentRA.toFixed(6);
    if (byId('input-dec')) byId('input-dec').value = state.currentDec.toFixed(6);
    if (byId('input-radius')) byId('input-radius').value = state.currentRadius.toFixed(5);
    if (byId('info-radec')) byId('info-radec').textContent =
        `${state.currentRA.toFixed(5)}°, ${state.currentDec >= 0 ? '+' : ''}${state.currentDec.toFixed(5)}°`;
    aladin?.gotoRaDec(state.currentRA, state.currentDec);
    aladin?.setFov(state.currentRadius);
    return true;
}

async function loadLocalFitsBatch(files) {
    const fitsFiles = files.filter((file) => /\.(fits?|fts)$/i.test(file.name || ''));
    if (!fitsFiles.length) {
        setObservationStatus('No se encontraron archivos FITS válidos en la selección.', '');
        return;
    }
    let succeeded = 0;
    for (let index = 0; index < fitsFiles.length; index += 1) {
        showFitsProgress('CREANDO TU MAPA CELESTE', `Procesando imagen ${index + 1} de ${fitsFiles.length}: ${fitsFiles[index].name}`, 0);
        if (await loadLocalFits(fitsFiles[index])) succeeded += 1;
    }
    hideFitsProgress();
    setObservationStatus(
        `Carga finalizada: ${succeeded} de ${fitsFiles.length} FITS incorporados.`,
        `${savedSkyRecords.length} imágenes guardadas`
    );
}

async function loadLocalFits(file, existingRecordId = null) {
    const name = String(file?.name || 'observation.fits');
    if (!/\.(fits?|fts)$/i.test(name)) {
        setObservationStatus('Formato no válido. Selecciona un FITS sin comprimir.', '');
        return;
    }
    if (file.size > 120 * 1024 * 1024) {
        setObservationStatus('El archivo supera el límite de 120 MB.', '');
        return;
    }
    if (!file.size) {
        setObservationStatus('El archivo seleccionado está vacío.', '');
        return;
    }
    try {
        showFitsProgress('INCORPORANDO IMAGEN FITS', 'Subiendo ' + name + '…', 0);
        setObservationStatus('Preparando FITS: ' + name, 'Procesando');
        const result = await uploadFitsToBackend(file, (percent) => {
            showFitsProgress('SUBIENDO ARCHIVO', name + ' · ' + (file.size / 1048576).toFixed(1) + ' MB', percent);
        });
        if (!result || !result.id || !result.preview_url || !Number(result.width) || !Number(result.height)) {
            throw new Error('El servidor no devolvió una vista previa FITS válida.');
        }
        showFitsProgress('DECODIFICANDO DATOS CIENTÍFICOS', 'Leyendo HDU, imagen y coordenadas WCS…', 84);
        const hasWcs = updateSkyCoordinates(result);
        const localId = existingRecordId || (crypto.randomUUID ? crypto.randomUUID() : 'fits-' + Date.now());
        const record = {
            id: localId, filename: name, file,
            ra: result.ra !== null && result.ra !== undefined && Number.isFinite(Number(result.ra)) ? Number(result.ra) : null,
            dec: result.dec !== null && result.dec !== undefined && Number.isFinite(Number(result.dec)) ? Number(result.dec) : null,
            width: result.width, height: result.height,
            hdu_index: result.hdu_index, hdu_count: result.hdu_count,
            pixel_scale_arcsec: result.pixel_scale_arcsec, size_bytes: file.size,
            saved_at: new Date().toISOString()
        };
        await saveSkyRecord(record);
        savedSkyRecords = await getSavedSkyRecords();
        renderSavedSkyMap();
        if (hasWcs) rebuildSkyMarkers();

        const token = ++fitsLoadToken;
        const image = byId('fits-local-image');
        const localViewer = byId('fits-local-viewer');
        const aladinContainer = byId('aladin-lite-div');
        if (!image || !localViewer) throw new Error('No se encuentra el visor FITS local.');
        showFitsProgress('RENDERIZANDO IMAGEN', 'Descargando la previsualización procesada…', 92);
        const previewResponse = await fetch(result.preview_url, { cache: 'no-store' });
        if (!previewResponse.ok) throw new Error('El servidor procesó el FITS, pero la vista previa respondió HTTP ' + previewResponse.status + '.');
        const previewBlob = await previewResponse.blob();
        if (!previewBlob.type.includes('image/')) throw new Error('La respuesta de vista previa no es una imagen.');
        const previewObjectUrl = URL.createObjectURL(previewBlob);
        if (activeLocalFitsUrl) URL.revokeObjectURL(activeLocalFitsUrl);
        activeLocalFitsUrl = previewObjectUrl;
        image.src = previewObjectUrl;
        if (image.decode) await image.decode();
        else await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error('El navegador no pudo decodificar la imagen FITS.'));
        });
        if (token !== fitsLoadToken) return;
        localFitsZoom = 1;
        localFitsPan = { x: 0, y: 0 };
        applyLocalFitsTransform();
        byId('fits-local-title').textContent = name;
        byId('fits-local-coords').textContent = hasWcs
            ? 'RA ' + Number(result.ra).toFixed(5) + '° · Dec ' + Number(result.dec).toFixed(5) + '°'
            : 'WCS no incluido · imagen mostrada sin coordenadas celestes';
        localViewer.hidden = false;
        if (aladinContainer) aladinContainer.style.display = 'none';
        setActiveLayer('layer-fits');
        if (byId('info-epoch-label')) byId('info-epoch-label').textContent = name;
        if (byId('hud-survey')) byId('hud-survey').textContent = hasWcs ? 'FITS LOCAL · WCS' : 'FITS LOCAL · SIN WCS';
        if (byId('timeline-epoch-title')) byId('timeline-epoch-title').textContent = name;
        if (byId('fits-dropzone')) byId('fits-dropzone').classList.add('fits-loaded');
        setObservationStatus(
            'Imagen FITS renderizada y guardada: ' + name,
            'HDU ' + result.hdu_index + ' · ' + result.width + '×' + result.height + (hasWcs ? '' : ' · sin WCS')
        );
        showFitsProgress('IMAGEN INCORPORADA', 'La imagen ya está visible en el visor local.', 100);
        setTimeout(hideFitsProgress, 650);
        return true;
    } catch (error) {
        hideFitsProgress();
        console.error('FITS upload failed', error);
        setObservationStatus('No se pudo incorporar el FITS: ' + error.message, 'Error de carga');
        return false;
    }
}

async function loadRemoteObservationFits(item) {
    const sourceUrl = observationUrl(item);
    if (!sourceUrl || !aladin || typeof aladin.displayFITS !== 'function') {
        if (aladin) aladin.setImageSurvey('P/DSS2/color');
        return;
    }
    const token = ++fitsLoadToken;
    const label = observationLabel(item);
    const proxyUrl = productProxyUrl(item);
    setObservationStatus(`Descargando y decodificando producto SPHEREx: ${label}…`, 'Cargando FITS');
    try {
        aladin.displayFITS(
            proxyUrl,
            { name: label },
            () => {
                if (token !== fitsLoadToken) return;
                setActiveLayer('layer-fits');
                if (byId('info-epoch-label')) byId('info-epoch-label').textContent = label;
                if (byId('hud-survey')) byId('hud-survey').textContent = 'SPHEREx FITS · IRSA';
                setObservationStatus(`Producto FITS decodificado: ${label}`, 'IRSA SIA2');
            },
            (error) => {
                if (token !== fitsLoadToken) return;
                console.error('IRSA FITS decoding failed', error);
                setObservationStatus('IRSA encontró la observación, pero no se pudo decodificar su FITS. Prueba otro producto.', '');
            }
        );
    } catch (error) {
        if (token === fitsLoadToken) setObservationStatus(`Error al abrir el producto FITS: ${error.message}`, '');
    }
}

function parseObservationIndex(value) {
    if (!/^\d+$/.test(String(value).trim()) || observations.length === 0) return null;
    const oneBased = Number(value);
    if (!Number.isSafeInteger(oneBased) || oneBased < 1 || oneBased > observations.length) return null;
    return oneBased - 1;
}

function setActiveLayer(id) {
    ['layer-real', 'layer-fits'].forEach((buttonId) => byId(buttonId)?.classList.toggle('active', buttonId === id));
}

async function initAladinViewer() {
    if (aladin) {
        aladin.invalidateSize();
        return;
    }
    if (!window.A?.init) {
        setObservationStatus('No se pudo cargar Aladin Lite; comprueba la conexión al servicio CDS.', '');
        return;
    }
    try {
        await A.init;
        aladin = A.aladin('#aladin-lite-div', {
            fov: state.currentRadius, projection: 'AIT', cooFrame: 'equatorial',
            showCooGridControl: true, showSimbadPointerControl: true, showCooGrid: true,
            survey: 'P/DSS2/color', target: `${state.currentRA} ${state.currentDec}`
        });
        aladin.on('positionChanged', (ra, dec) => {
            if (byId('hud-coords')) byId('hud-coords').textContent =
                `RA: ${ra.toFixed(4)} | Dec: ${dec >= 0 ? '+' : ''}${dec.toFixed(4)}`;
        });
        aladin.gotoRaDec(state.currentRA, state.currentDec);
        rebuildSkyMarkers();
    } catch (error) {
        console.error('Aladin initialization failed', error);
        setObservationStatus('Error al iniciar el visor astronómico.', '');
    }
}

async function searchObservations() {
    if (requestController) requestController.abort();
    requestController = new AbortController();
    setObservationStatus('Consultando el archivo IRSA…', 'Cargando');
    const params = new URLSearchParams({
        ra: String(state.currentRA), dec: String(state.currentDec), radius: String(state.currentRadius), limit: '100'
    });
    try {
        const response = await fetch(`${API}/api/observations?${params}`, { signal: requestController.signal });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.detail || `Error HTTP ${response.status}`);
        observations = Array.isArray(payload.observations) ? payload.observations.filter((item) => observationUrl(item)) : [];
        state.currentIndex = 0;
        state.splitIndexLeft = 0;
        state.splitIndexRight = Math.max(0, observations.length - 1);
        updateObservationControls();
        const demo = payload.is_demo === true;
        const source = payload.source || 'Fuente no especificada';
        const badge = byId('demo-indicator');
        if (badge) {
            badge.textContent = demo ? 'MODO DEMO — DATOS NO CIENTÍFICOS' : 'FUENTE: IRSA SIA2 DR1 + QR3';
            badge.setAttribute('aria-label', source);
        }
        setObservationStatus(demo ? 'DEMO — no son observaciones científicas reales.' : 'Conectado a IRSA SIA2 · producto FITS seleccionable',
            `${payload.count ?? observations.length} observación(es)`);
        updateSkyPosition();
        renderObservationList();
        showSelectedObservation();
    } catch (error) {
        if (error.name === 'AbortError') return;
        observations = [];
        updateObservationControls();
        setObservationStatus(`No se pudieron consultar observaciones: ${error.message}`, 'Sin resultados disponibles');
        const badge = byId('demo-indicator');
        if (badge) badge.textContent = 'IRSA SIA2 NO DISPONIBLE';
        renderObservationList('IRSA no está disponible. No se muestran datos simulados como resultados.');
        if (aladin) aladin.setImageSurvey('P/DSS2/color');
    }
}

async function loadCatalog() {
    const path = byId('catalog-path')?.value.trim() || '';
    const status = byId('catalog-status');
    const results = byId('catalog-results');
    if (status) status.textContent = 'Conectando con el directorio oficial de SPHEREx en IRSA…';
    if (results) results.replaceChildren();
    const params = new URLSearchParams({ path, page: '1', page_size: '100' });
    try {
        const response = await fetch('/api/catalog?' + params);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.detail || 'Error HTTP ' + response.status);
        catalogEntries = [...(payload.directories || []), ...(payload.files || payload.observations || [])];
        if (status) status.textContent = catalogEntries.length + ' elemento(s) en ' + (payload.path || 'raíz SPHEREx') + ' · Los FITS se descargan desde IRSA.';
        renderCatalogEntries(catalogEntries);
    } catch (error) {
        catalogEntries = [];
        if (status) status.textContent = 'No se pudo abrir este directorio: ' + error.message + '. Comprueba la URL o inténtalo más tarde.';
        if (results) {
            const link = document.createElement('a');
            link.href = 'https://irsa.ipac.caltech.edu/ibe/data/spherex/';
            link.target = '_blank';
            link.rel = 'noopener';
            link.textContent = 'Abrir el archivo SPHEREx directamente en IRSA';
            link.className = 'ylma-link';
            results.appendChild(link);
        }
    }
}

function renderCatalogEntries(entries) {
    const container = byId('catalog-results');
    if (!container) return;
    container.replaceChildren();
    if (!entries.length) {
        const empty = document.createElement('p');
        empty.className = 'doc-text';
        empty.textContent = 'Este directorio no contiene elementos visibles.';
        container.appendChild(empty);
        return;
    }
    entries.forEach((entry) => {
        const isDirectory = entry.kind === 'directory';
        if (isDirectory) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'catalog-entry';
            button.textContent = '📁  ' + entry.name;
            button.title = entry.path;
            button.addEventListener('click', async () => {
                if (byId('catalog-path')) byId('catalog-path').value = entry.path;
                await loadCatalog();
            });
            container.appendChild(button);
        } else {
            const link = document.createElement('a');
            link.className = 'catalog-entry catalog-download-entry';
            link.href = entry.url;
            link.target = '_blank';
            link.rel = 'noopener';
            link.download = entry.name;
            link.textContent = '↓  DESCARGAR  ' + entry.name + (entry.size_bytes ? ' · ' + (entry.size_bytes / 1048576).toFixed(1) + ' MB' : '');
            link.title = entry.path;
            container.appendChild(link);
        }
    });
}

function updateSkyPosition() {
    if (aladin) {
        aladin.gotoRaDec(state.currentRA, state.currentDec);
        aladin.setFov(state.currentRadius);
    }
    if (byId('info-radec')) byId('info-radec').textContent =
        `${state.currentRA.toFixed(3)}, ${state.currentDec >= 0 ? '+' : ''}${state.currentDec.toFixed(3)}`;
}

function updateObservationControls() {
    const max = observations.length;
    const main = byId('epoch-index');
    if (main) {
        main.value = max ? String(Math.min(state.currentIndex + 1, max)) : '';
        main.placeholder = max ? `1–${max}` : 'Sin observaciones';
        main.disabled = max === 0;
        main.setAttribute('aria-label', max ? `Número de observación, de 1 a ${max}` : 'No hay observaciones');
    }
    [['split-index-left', state.splitIndexLeft], ['split-index-right', state.splitIndexRight]].forEach(([id, index]) => {
        const input = byId(id);
        if (!input) return;
        input.value = max ? String(Math.min(Number(index) + 1, max)) : '';
        input.placeholder = max ? `1–${max}` : 'Sin datos';
        input.disabled = max === 0;
    });
}

function observationLabel(item) {
    return item.obs_id || item.obs_publisher_did || item.target_name || 'Identificador no disponible';
}

function observationDate(item) {
    return item.t_min ?? item.date_obs ?? item.obs_date ?? 'Fecha no disponible';
}

function observationUrl(item) {
    const value = item.access_url;
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname === 'irsa.ipac.caltech.edu' &&
            url.pathname.startsWith('/ibe/data/spherex/') && /\.(fits?|fts)$/i.test(url.pathname)
            ? url.href : null;
    } catch { return null; }
}

function productProxyUrl(item) {
    const url = observationUrl(item);
    return url ? `/api/product?${new URLSearchParams({ url })}` : null;
}

function showSelectedObservation() {
    const item = observations[state.currentIndex];
    if (!item) {
        if (byId('info-epoch-label')) byId('info-epoch-label').textContent = 'Sin observación seleccionada';
        if (byId('hud-survey')) byId('hud-survey').textContent = 'Atlas DSS2 — sin producto SPHEREx disponible';
        if (byId('timeline-epoch-title')) byId('timeline-epoch-title').textContent = 'No hay épocas reales en estos resultados';
        if (byId('hud-time-display')) byId('hud-time-display').textContent = '—';
        if (aladin) aladin.setImageSurvey('P/DSS2/color');
        return;
    }
    const label = observationLabel(item);
    const date = observationDate(item);
    if (byId('info-epoch-label')) byId('info-epoch-label').textContent = label;
    if (byId('timeline-epoch-title')) byId('timeline-epoch-title').textContent = `OBSERVACIÓN: ${label}`;
    if (byId('hud-time-display')) byId('hud-time-display').textContent = String(date);
    if (byId('hud-survey')) byId('hud-survey').textContent = `IRSA: ${label}`;
    updateSkyPosition();
    const url = observationUrl(item);
    if (url && aladin) {
        loadRemoteObservationFits(item);
    } else if (aladin) {
        setActiveLayer('layer-real');
        aladin.setImageSurvey('P/DSS2/color');
        setObservationStatus('La observación no incluye una URL FITS descargable.', 'Sin producto FITS');
    }
}

function renderObservationList(message = '') {
    const container = byId('objects-list-container');
    if (!container) return;
    container.replaceChildren();
    if (message || observations.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'doc-text';
        empty.textContent = message || 'No se encontraron observaciones IRSA para esta búsqueda.';
        container.appendChild(empty);
        return;
    }
    observations.forEach((item, index) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'observation-card';
        card.textContent = `${observationLabel(item)} — ${observationDate(item)} — RA ${item.s_ra ?? '—'}, Dec ${item.s_dec ?? '—'}`;
        card.addEventListener('click', () => {
            state.currentIndex = index;
            if (byId('epoch-index')) byId('epoch-index').value = String(index + 1);
            byId('objects-modal').classList.remove('active');
            showSelectedObservation();
        });
        container.appendChild(card);
    });
}

function toggleSplitView() {
    if (activeLocalFitsUrl && !comparisonLocalFitsUrl) {
        pendingLocalCompareMode = 'split';
        setObservationStatus('Carga una segunda imagen FITS para compararla en vista dividida.', '');
        byId('compare-fits-input')?.click();
        return;
    }
    if (activeLocalFitsUrl && comparisonLocalFitsUrl) {
        isSplitMode = !isSplitMode;
        byId('btn-split')?.classList.toggle('active', isSplitMode);
        byId('aladin-lite-div').style.display = isSplitMode ? 'none' : 'none';
        byId('normal-timeline').style.display = isSplitMode ? 'none' : 'flex';
        byId('split-view-container').style.display = 'none';
        byId('split-local-container').style.display = isSplitMode ? 'grid' : 'none';
        byId('fits-local-viewer').hidden = isSplitMode;
        if (isSplitMode) renderLocalSplitComparison();
        return;
    }
    if (!observations.length) {
        if (activeLocalFitsUrl) {
            pendingLocalCompareMode = 'split';
            setObservationStatus('Selecciona ahora la segunda imagen FITS para abrir la vista dividida.', '');
            byId('compare-fits-input')?.click();
        } else {
            setObservationStatus('Primero incorpora una imagen FITS principal.', '');
            byId('local-fits-input')?.click();
        }
        return;
    }
    isSplitMode = !isSplitMode;
    byId('btn-split')?.classList.toggle('active', isSplitMode);
    byId('aladin-lite-div').style.display = isSplitMode ? 'none' : 'block';
    byId('normal-timeline').style.display = isSplitMode ? 'none' : 'flex';
    byId('split-view-container').style.display = isSplitMode ? 'grid' : 'none';
    byId('split-local-container').style.display = 'none';
    if (isSplitMode) initSplitView();
    else aladin?.invalidateSize();
}

async function initSplitView() {
    if (!window.A?.init) return;
    try {
        await A.init;
        if (!aladinLeft) aladinLeft = A.aladin('#aladin-left-div', {
            fov: state.currentRadius, projection: 'AIT', survey: 'P/DSS2/color', target: `${state.currentRA} ${state.currentDec}`
        });
        if (!aladinRight) aladinRight = A.aladin('#aladin-right-div', {
            fov: state.currentRadius, projection: 'AIT', survey: 'P/DSS2/color', target: `${state.currentRA} ${state.currentDec}`
        });
        aladinLeft.invalidateSize(); aladinRight.invalidateSize();
        updateSplitPane('left', state.splitIndexLeft);
        updateSplitPane('right', state.splitIndexRight);
    } catch (error) {
        console.error('Split view initialization failed', error);
        setObservationStatus('No se pudo iniciar la vista dividida.', '');
    }
}

function updateSplitPane(side, index) {
    const item = observations[index];
    if (!item) return;
    const viewer = side === 'left' ? aladinLeft : aladinRight;
    const title = byId(side === 'left' ? 'split-left-title' : 'split-right-title');
    if (title) title.textContent = `${side === 'left' ? 'ÉPOCA A' : 'ÉPOCA B'}: ${observationLabel(item)} — ${observationDate(item)}`;
    if (!viewer) return;
    viewer.gotoRaDec(state.currentRA, state.currentDec);
    viewer.setFov(state.currentRadius);
    const proxyUrl = productProxyUrl(item);
    if (proxyUrl && typeof viewer.displayFITS === 'function') {
        try { viewer.displayFITS(proxyUrl, { name: observationLabel(item) }); }
        catch (error) { console.warn('Unable to decode IRSA FITS in split view', error); }
    } else viewer.setImageSurvey('P/DSS2/color');
}

function toggleBlink() {
    if (isBlinkingActive) { stopBlink(); return; }
    if (activeLocalFitsUrl && comparisonLocalFitsUrl) {
        isBlinkingActive = true;
        const button = byId('blink-start-toggle');
        if (button) button.textContent = 'DETENER BLINK';
        const imageA = activeLocalFitsUrl;
        const imageB = comparisonLocalFitsUrl;
        const preview = byId('blink-local-image');
        if (preview) {
            preview.src = imageA;
            preview.style.display = 'block';
        }
        let showSecond = false;
        const blinkOnce = () => {
            showSecond = !showSecond;
            if (preview) preview.src = showSecond ? imageB : imageA;
            const label = byId('blink-status-label');
            if (label) label.textContent = (showSecond ? 'IMAGEN B: ' + comparisonLocalFitsName : 'IMAGEN A: ' + (byId('fits-local-title')?.textContent || 'FITS principal'));
        };
        blinkOnce();
        blinkInterval = setInterval(blinkOnce, 1000);
        return;
    }
    if (observations.length < 2) {
        const label = byId('blink-status-label');
        if (label) label.textContent = 'Carga dos imágenes FITS o consulta al menos dos observaciones IRSA para comparar.';
        byId('compare-fits-input')?.click();
        return;
    }
    isBlinkingActive = true;
    const button = byId('blink-start-toggle');
    if (button) button.textContent = 'DETENER BLINK';
    const first = byId('blink-epoch-1');
    const second = byId('blink-epoch-2');
    [first, second].forEach((select, idx) => {
        if (!select) return;
        select.replaceChildren();
        observations.forEach((item, i) => {
            const option = document.createElement('option');
            option.value = String(i + 1);
            option.textContent = `${observationLabel(item)} — ${observationDate(item)}`;
            select.appendChild(option);
        });
        select.value = String(idx === 0 ? 1 : observations.length);
    });
    let flip = false;
    const blinkOnce = () => {
        flip = !flip;
        const index = Number((flip ? first : second)?.value ?? 1) - 1;
        const item = observations[index];
        const label = byId('blink-status-label');
        if (label && item) label.textContent = `${flip ? 'ÉPOCA 1' : 'ÉPOCA 2'}: ${observationLabel(item)} — ${observationDate(item)}`;
        const proxyUrl = item && productProxyUrl(item);
        if (proxyUrl && aladin && typeof aladin.displayFITS === 'function') {
            try { aladin.displayFITS(proxyUrl, { name: observationLabel(item) }); }
            catch (error) { console.warn('Blink FITS decoding failed', error); }
        }
    };
    blinkOnce();
    blinkInterval = setInterval(blinkOnce, 1000);
}

function stopBlink() {
    isBlinkingActive = false;
    if (blinkInterval) clearInterval(blinkInterval);
    blinkInterval = null;
    const button = byId('blink-start-toggle');
    if (button) button.textContent = 'INICIAR BLINK';
}

function toggleFullscreen() {
    const stage = byId('visor-stage');
    if (!document.fullscreenElement) stage?.requestFullscreen().catch((error) => console.warn('Fullscreen unavailable', error));
    else document.exitFullscreen().catch((error) => console.warn('Could not exit fullscreen', error));
}
