(() => {
'use strict';
const MAX_FILES = 16;
const MAX_BYTES = 120 * 1024 * 1024;
const state = { viewer: null, layers: [], blinking: false, blinkTimer: null, blinkIndex: 0, splitViewers: [], splitMode: false, previousVisibility: [] };
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
    stopBlink();
    $('multi-load-btn').disabled = true;
    try {
        const viewer = await initSphere();
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
$('multi-load-btn').addEventListener('click', loadSelectedFiles);
$('multi-blink-btn').addEventListener('click', startBlink);
$('multi-split-btn').addEventListener('click', () => state.splitMode ? closeSplit() : openSplit());
$('multi-sphere-btn').addEventListener('click', closeSplit);
$('multi-blink-interval').addEventListener('change', changeBlinkInterval);
$('multi-projection').addEventListener('change', setProjection);
window.addEventListener('beforeunload', () => stopBlink(false));
})();