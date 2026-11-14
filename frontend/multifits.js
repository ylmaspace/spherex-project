(() => {
'use strict';
const MAX_FILES = 16;
const MAX_BYTES = 120 * 1024 * 1024;
const MAX_BATCH_BYTES = 600 * 1024 * 1024;
const state = { viewer: null, layers: [], directoryPath: '', directoryFiles: [], importingDirectory: false, blinking: false, blinkTimer: null, blinkIndex: 0, splitViewers: [], splitMode: false, previousVisibility: [] };
const $ = (id) => document.getElementById(id);
const setStatus = (message, progress) => {
    $('multi-status').textContent = message;
    if (Number.isFinite(progress)) $('multi-progress-bar').style.width = Math.max(0, Math.min(100, progress)) + '%';
};
const selectedInterval = () => [2000, 1000, 500, 333].includes(Number($('multi-blink-interval').value)) ? Number($('multi-blink-interval').value) : 1000;
const safeName = (name) => String(name || 'FITS').replace(/[<>&"]/g, '');
const absoluteApiUrl = (path) => new URL(path, window.location.origin).href;

function loadFallbackAladin() {
    return new Promise((resolve, reject) => {
        if (window.A && typeof window.A.aladin === 'function') return resolve();
        const script = document.createElement('script');
        script.src = 'https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js';
        script.onload = () => window.A && typeof window.A.aladin === 'function' ? resolve() : reject(new Error('La biblioteca Aladin Lite no expone A.aladin.'));
        script.onerror = () => reject(new Error('No se pudo cargar Aladin Lite 3.9.0-beta ni la versión estable de respaldo.'));
        document.head.appendChild(script);
    });
}

function initSphere() {
    if (state.viewer) return Promise.resolve(state.viewer);
    return loadFallbackAladin().then(() => {
        state.viewer = window.A.aladin('#multi-sphere-viewer', {
            survey: 'P/DSS2/color', target: '150.1 2.2', fov: 180,
            projection: 'SIN', cooFrame: 'ICRS', showCooGrid: true,
            showProjectionControl: true, showLayersControl: true,
            showFullscreenControl: true, showCooLocation: true,
            showReticle: true, mode: 'dark'
        });
        if (!state.viewer || typeof state.viewer.displayFITS !== 'function') throw new Error('La versión cargada de Aladin Lite no ofrece displayFITS.');
        if (typeof state.viewer.on === 'function') {
            state.viewer.on('mouseMove', (position) => {
                if (!position || !Number.isFinite(position.ra) || !Number.isFinite(position.dec)) return;
                $('multi-cursor-coords').textContent = 'RA ' + position.ra.toFixed(6) + '° · Dec ' + position.dec.toFixed(6) + '°';
            });
        }
        return state.viewer;
    });
}

function uploadFits(file, progressCallback) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/fits/upload');
        xhr.timeout = 8 * 60 * 1000;
        xhr.responseType = 'json';
        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) progressCallback(event.loaded / event.total * 85);
        };
        xhr.onload = () => {
            let payload = xhr.response;
            if (!payload || typeof payload !== 'object') {
                try { payload = JSON.parse(xhr.responseText || '{}'); } catch (_) { payload = {}; }
            }
            if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
            else reject(new Error(payload.detail || 'El servidor respondió HTTP ' + xhr.status + '.'));
        };
        xhr.onerror = () => reject(new Error('Se perdió la conexión durante la carga.'));
        xhr.ontimeout = () => reject(new Error('El servidor agotó el tiempo de espera al procesar ' + file.name + '.'));
        const form = new FormData();
        form.append('file', file, file.name);
        xhr.send(form);
    });
}

function displayLayer(viewer, record, layerId) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) { settled = true; reject(new Error('Aladin no confirmó la decodificación de ' + record.filename + '.')); }
        }, 180000);
        try {
            viewer.displayFITS(absoluteApiUrl(record.display_url), {
                name: record.filename, opacity: 0.58, colormap: 'native'
            }, (ra, dec, fov, image) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ image, ra, dec, fov, layerId });
            }, (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(new Error('No se pudo decodificar ' + record.filename + (error ? ': ' + error : '.')));
            }, layerId);
        } catch (error) {
            clearTimeout(timer);
            reject(error);
        }
    });
}

async function loadSelectedFiles() {
    const files = Array.from($('multi-fits-input').files || []);
    if (!files.length) { setStatus('Selecciona al menos un archivo FITS.', 0); return; }
    if (files.length > MAX_FILES) { setStatus('El límite inicial es de ' + MAX_FILES + ' FITS por lote.', 0); return; }
    const invalid = files.find(file => !/\.(fits?|fts)$/i.test(file.name) || !file.size || file.size > MAX_BYTES);
    if (invalid) { setStatus('Archivo no válido o superior a 120 MB: ' + invalid.name, 0); return; }
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_BATCH_BYTES) { setStatus('El lote supera el límite de 600 MB. Divide la selección en varios lotes.', 0); return; }
    stopBlink();
    $('multi-load-btn').disabled = true;
    try {
        const viewer = await initSphere();
        viewer.setProjection($('multi-projection').value);
        let success = 0;
        for (let index = 0; index < files.length; index++) {
            const file = files[index];
            setStatus('Subiendo y procesando ' + file.name + ' (' + (index + 1) + '/' + files.length + ')…', index / files.length * 100);
            const result = await uploadFits(file, percent => {
                setStatus('Procesando ' + file.name + ' · ' + Math.round(percent) + '%', ((index + percent / 100) / files.length) * 100);
            });
            if (!result.id || !result.display_url) throw new Error('El backend no devolvió una FITS procesada para ' + file.name + '.');
            const layerId = 'ylma-multifits-' + result.id;
            setStatus('Renderizando ' + file.name + ' en la esfera…', ((index + 0.9) / files.length) * 100);
            const rendered = await displayLayer(viewer, result, layerId);
            if (rendered.image && typeof rendered.image.setOpacity === 'function') rendered.image.setOpacity(0.58);
            state.layers.push({
                id: layerId, filename: file.name, image: rendered.image,
                ra: Number.isFinite(rendered.ra) ? rendered.ra : result.ra,
                dec: Number.isFinite(rendered.dec) ? rendered.dec : result.dec,
                width: result.width, height: result.height, display_url: result.display_url,
                visible: true, opacity: 0.58
            });
            success++;
            renderLayerList();
            if (success === 1 && Number.isFinite(rendered.ra) && Number.isFinite(rendered.dec)) viewer.gotoRaDec(rendered.ra, rendered.dec);
        }
        setStatus(success + ' de ' + files.length + ' imágenes cargadas y renderizadas.', 100);
        $('multi-blink-btn').disabled = state.layers.length < 2;
        $('multi-split-btn').disabled = state.layers.length < 2;
        $('multi-fits-input').value = '';
    } catch (error) {
        console.error('Multi-FITS load error', error);
        setStatus('Carga interrumpida: ' + error.message, 0);
    } finally {
        $('multi-load-btn').disabled = false;
        $('multi-blink-btn').disabled = state.layers.length < 2;
        $('multi-split-btn').disabled = state.layers.length < 2;
    }
}

function setLayerVisibility(layer, visible) {
    if (!layer.image || layer.visible === visible) return;
    if (typeof layer.image.toggle === 'function') layer.image.toggle();
    layer.visible = visible;
}
function renderLayerList() {
    $('multi-layer-count').textContent = state.layers.length + (state.layers.length === 1 ? ' imagen' : ' imágenes');
    const list = $('multi-layer-list');
    list.replaceChildren();
    if (!state.layers.length) {
        const empty = document.createElement('div'); empty.className = 'multi-empty';
        empty.textContent = 'Todavía no hay imágenes. Selecciona varios archivos FITS para comenzar.';
        list.appendChild(empty); return;
    }
    state.layers.forEach((layer, index) => {
        const row = document.createElement('div'); row.className = 'multi-layer-item';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = layer.visible;
        checkbox.setAttribute('aria-label', 'Mostrar ' + layer.filename);
        checkbox.addEventListener('change', () => { setLayerVisibility(layer, checkbox.checked); });
        const details = document.createElement('div');
        const name = document.createElement('strong'); name.textContent = (index + 1) + '. ' + layer.filename;
        const meta = document.createElement('small');
        meta.textContent = layer.width + '×' + layer.height + (Number.isFinite(layer.ra) && Number.isFinite(layer.dec) ? ' · RA ' + layer.ra.toFixed(4) + '° · Dec ' + layer.dec.toFixed(4) + '°' : ' · WCS no disponible');
        details.append(name, meta);
        const opacity = document.createElement('input'); opacity.type = 'range'; opacity.min = '0'; opacity.max = '1'; opacity.step = '0.05'; opacity.value = String(layer.opacity);
        opacity.setAttribute('aria-label', 'Opacidad de ' + layer.filename);
        opacity.addEventListener('input', () => {
            layer.opacity = Number(opacity.value);
            if (layer.image && typeof layer.image.setOpacity === 'function') layer.image.setOpacity(layer.opacity);
        });
        row.append(checkbox, details, opacity); list.appendChild(row);
    });
}

function setOnlyLayer(index) {
    state.layers.forEach((layer, i) => setLayerVisibility(layer, i === index));
}
function stopBlink(restore = true) {
    if (state.blinkTimer) clearInterval(state.blinkTimer);
    state.blinkTimer = null; state.blinking = false;
    if (restore && state.previousVisibility.length) {
        state.layers.forEach((layer, index) => setLayerVisibility(layer, state.previousVisibility[index]));
    }
    state.previousVisibility = [];
    $('multi-blink-btn').textContent = 'MEGABLINK';
}
function startBlink() {
    if (state.blinking) { stopBlink(); return; }
    if (state.layers.length < 2) { setStatus('Carga al menos dos FITS para iniciar el Blink.', 0); return; }
    if (state.splitMode) closeSplit();
    state.previousVisibility = state.layers.map(layer => layer.visible);
    state.blinking = true; state.blinkIndex = -1;
    const tick = () => {
        state.blinkIndex = (state.blinkIndex + 1) % state.layers.length;
        setOnlyLayer(state.blinkIndex);
        setStatus('MEGABLINK · ' + (state.blinkIndex + 1) + '/' + state.layers.length + ' · ' + state.layers[state.blinkIndex].filename);
    };
    $('multi-blink-btn').textContent = 'DETENER BLINK';
    tick(); state.blinkTimer = setInterval(tick, selectedInterval());
}
function changeBlinkInterval() {
    if (!state.blinking) return;
    if (state.blinkTimer) clearInterval(state.blinkTimer);
    state.blinkTimer = setInterval(() => {
        state.blinkIndex = (state.blinkIndex + 1) % state.layers.length;
        setOnlyLayer(state.blinkIndex);
        setStatus('MEGABLINK · ' + (state.blinkIndex + 1) + '/' + state.layers.length + ' · ' + state.layers[state.blinkIndex].filename);
    }, selectedInterval());
}

async function openSplit() {
    if (state.layers.length < 2) { setStatus('Carga al menos dos FITS para usar pantalla dividida.', 0); return; }
    stopBlink();
    state.splitMode = true;
    $('multi-sphere-viewer').hidden = true;
    $('multi-split-grid').hidden = false;
    $('multi-view-title').textContent = 'PANTALLA DIVIDIDA';
    $('multi-view-subtitle').textContent = 'Hasta cuatro paneles independientes · selecciona cualquier FITS en cada panel';
    $('multi-split-grid').replaceChildren();
    const count = Math.min(4, state.layers.length);
    for (let index = 0; index < count; index++) {
        const pane = document.createElement('section'); pane.className = 'multi-split-pane';
        const toolbar = document.createElement('div'); toolbar.className = 'multi-split-toolbar';
        const label = document.createElement('strong'); label.textContent = 'PANEL ' + (index + 1);
        const select = document.createElement('select'); select.setAttribute('aria-label', 'FITS del panel ' + (index + 1));
        state.layers.forEach((layer, layerIndex) => {
            const option = document.createElement('option'); option.value = String(layerIndex); option.textContent = layer.filename; select.appendChild(option);
        });
        select.value = String(index);
        toolbar.append(label, select);
        const viewerNode = document.createElement('div'); viewerNode.className = 'multi-split-viewer'; viewerNode.id = 'multi-split-viewer-' + index;
        const coords = document.createElement('div'); coords.className = 'multi-split-coords'; coords.textContent = 'RA —° · Dec —°';
        pane.append(toolbar, viewerNode, coords); $('multi-split-grid').appendChild(pane);
        const splitViewer = window.A.aladin('#' + viewerNode.id, {
            survey: 'P/DSS2/color', target: '150.1 2.2', fov: 10, projection: 'SIN',
            cooFrame: 'ICRS', showCooGrid: true, showProjectionControl: false,
            showLayersControl: false, showFullscreenControl: true, showReticle: true, mode: 'dark'
        });
        splitViewer.on && splitViewer.on('mouseMove', position => {
            if (position && Number.isFinite(position.ra) && Number.isFinite(position.dec)) {
                coords.textContent = 'RA ' + position.ra.toFixed(6) + '° · Dec ' + position.dec.toFixed(6) + '°';
            }
        });
        const paneState = { viewer: splitViewer, select, layerId: null, coords };
        state.splitViewers.push(paneState);
        const renderSelected = async () => {
            const selected = state.layers[Number(select.value)];
            if (paneState.layerId) splitViewer.removeImageLayer(paneState.layerId);
            paneState.layerId = 'ylma-split-' + index + '-' + selected.id;
            try {
                const result = await displayLayer(splitViewer, {
                    filename: selected.filename, display_url: state.layers[Number(select.value)].display_url || findDisplayUrl(selected.id)
                }, paneState.layerId);
                if (Number.isFinite(result.ra) && Number.isFinite(result.dec)) splitViewer.gotoRaDec(result.ra, result.dec);
            } catch (error) {
                coords.textContent = error.message;
            }
        };
        paneState.renderSelected = renderSelected;
        select.addEventListener('change', renderSelected);
        await renderSelected();
    }
    $('multi-sphere-btn').classList.remove('active');
    $('multi-split-btn').classList.add('active');
}
function findDisplayUrl(layerId) {
    const item = state.layers.find(layer => layer.id === layerId);
    return item?.display_url || '';
}
function closeSplit() {
    state.splitViewers.forEach(pane => {
        try { pane.viewer.remove(); } catch (_) {}
    });
    state.splitViewers = [];
    state.splitMode = false;
    $('multi-split-grid').hidden = true;
    $('multi-sphere-viewer').hidden = false;
    $('multi-view-title').textContent = 'ESFERA CELESTE';
    $('multi-view-subtitle').textContent = 'Proyección ortográfica · marco ICRS';
    $('multi-split-btn').classList.remove('active');
    $('multi-sphere-btn').classList.add('active');
    state.viewer && state.viewer.getParentDiv && state.viewer.getParentDiv();
}

function setProjection() {
    if (!state.viewer || typeof state.viewer.setProjection !== 'function') return;
    state.viewer.setProjection($('multi-projection').value);
    $('multi-view-subtitle').textContent = $('multi-projection').selectedOptions[0].textContent + ' · marco ICRS';
}

async function scanIRsaDirectory() {
    const raw = $('multi-directory-url').value.trim();
    if (!raw) { $('multi-directory-summary').textContent = 'Introduce la URL de una carpeta IRSA.'; return; }
    let parsed;
    try { parsed = new URL(raw); } catch (_) { $('multi-directory-summary').textContent = 'La URL no tiene un formato válido.'; return; }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'irsa.ipac.caltech.edu' ||
        !parsed.pathname.startsWith('/ibe/data/spherex/') || parsed.search || parsed.hash) {
        $('multi-directory-summary').textContent = 'Solo se admiten directorios HTTPS oficiales de IRSA SPHEREx, sin parámetros.';
        return;
    }
    $('multi-directory-scan').disabled = true;
    $('multi-directory-import').disabled = true;
    $('multi-directory-files').replaceChildren();
    $('multi-directory-summary').textContent = 'Consultando el índice oficial de IRSA…';
    try {
        const all = [];
        const firstUrl = new URL('/api/catalog', window.location.origin);
        firstUrl.searchParams.set('path', raw);
        firstUrl.searchParams.set('page', '1');
        firstUrl.searchParams.set('page_size', '100');
        const firstResponse = await fetch(firstUrl);
        const first = await firstResponse.json();
        if (!firstResponse.ok) throw new Error(first.detail || 'IRSA no ha podido listar este directorio.');
        const pages = Math.min(Number(first.pages) || 1, 50);
        all.push(...(first.observations || []));
        for (let page = 2; page <= pages; page++) {
            $('multi-directory-summary').textContent = 'Leyendo directorio… página ' + page + '/' + pages;
            const url = new URL('/api/catalog', window.location.origin);
            url.searchParams.set('path', raw); url.searchParams.set('page', String(page)); url.searchParams.set('page_size', '100');
            const response = await fetch(url);
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.detail || 'No se pudo leer la página ' + page + '.');
            all.push(...(payload.observations || []));
        }
        state.directoryPath = raw;
        state.directoryFiles = all;
        renderDirectoryFiles();
        $('multi-directory-select-all').disabled = all.length === 0;
        $('multi-directory-select-all').checked = all.length > 0;
        $('multi-directory-summary').textContent = all.length + ' FITS encontrados' +
            (Number(first.count) > all.length ? ' · índice limitado a 5.000 archivos para esta exploración' : '') +
            (all.length ? ' · selecciónalos y pulsa importar' : ' · no hay FITS en esta carpeta');
        $('multi-directory-import').disabled = all.length === 0;
    } catch (error) {
        $('multi-directory-summary').textContent = 'Error al explorar: ' + error.message;
    } finally {
        $('multi-directory-scan').disabled = false;
    }
}
function renderDirectoryFiles() {
    const container = $('multi-directory-files');
    container.replaceChildren();
    if (!state.directoryFiles.length) {
        const empty = document.createElement('div'); empty.className = 'multi-empty'; empty.textContent = 'No se han encontrado archivos FITS.';
        container.appendChild(empty); return;
    }
    state.directoryFiles.forEach((file, index) => {
        const label = document.createElement('label'); label.className = 'multi-directory-file';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = true;
        checkbox.dataset.index = String(index); checkbox.addEventListener('change', updateDirectorySelection);
        const text = document.createElement('span'); text.textContent = file.name;
        const meta = document.createElement('small'); meta.textContent = file.size_bytes ? (file.size_bytes / 1048576).toFixed(1) + ' MB' : 'Tamaño no indicado por IRSA';
        text.appendChild(meta); label.append(checkbox, text); container.appendChild(label);
    });
    updateDirectorySelection();
}
function updateDirectorySelection() {
    const selected = $('multi-directory-files').querySelectorAll('input[type="checkbox"]:checked').length;
    const total = state.directoryFiles.length;
    $('multi-directory-summary').textContent = selected + ' de ' + total + ' FITS seleccionados';
    $('multi-directory-import').disabled = selected === 0 || state.importingDirectory;
    $('multi-directory-select-all').checked = total > 0 && selected === total;
}
async function importDirectorySelection() {
    if (state.importingDirectory) return;
    const selectedIndexes = Array.from($('multi-directory-files').querySelectorAll('input[type="checkbox"]:checked'))
        .map(input => Number(input.dataset.index));
    const selected = selectedIndexes.map(index => state.directoryFiles[index]).filter(Boolean);
    if (!selected.length) return;
    if (!confirm('Se procesarán ' + selected.length + ' archivos FITS desde IRSA. La descarga y el análisis se harán desde el servidor. ¿Continuar?')) return;
    state.importingDirectory = true;
    $('multi-directory-import').disabled = true;
    $('multi-directory-scan').disabled = true;
    stopBlink();
    let loaded = 0, failed = 0;
    try {
        const viewer = await initSphere();
        viewer.setProjection($('multi-projection').value);
        for (let offset = 0; offset < selected.length; offset += MAX_FILES) {
            const batch = selected.slice(offset, offset + MAX_FILES);
            $('multi-directory-summary').textContent = 'Descargando lote ' + (Math.floor(offset / MAX_FILES) + 1) +
                ' · ' + Math.min(offset + batch.length, selected.length) + '/' + selected.length;
            const response = await fetch('/api/fits/import-directory', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({directory_path: state.directoryPath, files: batch.map(file => file.path)})
            });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.detail || 'El servidor no pudo importar el lote.');
            const results = payload.results || [];
            for (const result of results) {
                try {
                    const layerId = 'ylma-multifits-' + result.id;
                    const rendered = await displayLayer(viewer, result, layerId);
                    if (rendered.image && typeof rendered.image.setOpacity === 'function') rendered.image.setOpacity(0.58);
                    state.layers.push({
                        id: layerId, filename: result.filename, image: rendered.image,
                        ra: Number.isFinite(rendered.ra) ? rendered.ra : result.ra,
                        dec: Number.isFinite(rendered.dec) ? rendered.dec : result.dec,
                        width: result.width, height: result.height, display_url: result.display_url,
                        visible: true, opacity: 0.58
                    });
                    loaded++; renderLayerList();
                    if (loaded === 1 && Number.isFinite(rendered.ra) && Number.isFinite(rendered.dec)) viewer.gotoRaDec(rendered.ra, rendered.dec);
                } catch (error) {
                    failed++;
                    console.warn('No se pudo representar ' + result.filename, error);
                }
            }
            failed += (payload.errors || []).length;
            const details = (payload.errors || []).map(item => item.filename + ': ' + item.error).join(' · ');
            $('multi-directory-summary').textContent = 'Importados ' + loaded + '/' + selected.length +
                (failed ? ' · ' + failed + ' errores' : '') + (details ? ' · ' + details : '');
        }
        setStatus('Importación de directorio finalizada: ' + loaded + ' FITS incorporados' + (failed ? ', ' + failed + ' errores.' : '.'), 100);
    } catch (error) {
        setStatus('Importación de directorio interrumpida: ' + error.message, 0);
        $('multi-directory-summary').textContent = error.message;
    } finally {
        state.importingDirectory = false;
        $('multi-directory-import').disabled = state.directoryFiles.length === 0;
        $('multi-directory-scan').disabled = false;
        $('multi-blink-btn').disabled = state.layers.length < 2;
        $('multi-split-btn').disabled = state.layers.length < 2;
    }
}

$('multi-load-btn').addEventListener('click', loadSelectedFiles);
$('multi-blink-btn').addEventListener('click', startBlink);
$('multi-split-btn').addEventListener('click', () => state.splitMode ? closeSplit() : openSplit());
$('multi-sphere-btn').addEventListener('click', closeSplit);
$('multi-blink-interval').addEventListener('change', changeBlinkInterval);
$('multi-projection').addEventListener('change', setProjection);
$('multi-directory-scan').addEventListener('click', scanIRsaDirectory);
$('multi-directory-import').addEventListener('click', importDirectorySelection);
$('multi-directory-select-all').addEventListener('change', () => {
    $('multi-directory-files').querySelectorAll('input[type=checkbox]').forEach(input => { input.checked = $('multi-directory-select-all').checked; });
    updateDirectorySelection();
});
window.addEventListener('beforeunload', () => stopBlink(false));
})();