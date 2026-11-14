(() => {
'use strict';
const PACKAGE_FILES = 4;
const MAX_BYTES = 120 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 240 * 1024 * 1024;
let aladinReadyPromise = null;
const state = { viewer: null, layers: [], directoryPath: '', directoryFiles: [], importedDirectoryPaths: new Set(), importingDirectory: false, blinking: false, blinkTimer: null, blinkIndex: 0, splitViewers: [], splitMode: false, previousVisibility: [] };
const $ = (id) => document.getElementById(id);
const setStatus = (message, progress) => {
    $('multi-status').textContent = message;
    if (Number.isFinite(progress)) $('multi-progress-bar').style.width = Math.max(0, Math.min(100, progress)) + '%';
};
const selectedInterval = () => [2000, 1000, 500, 333].includes(Number($('multi-blink-interval').value)) ? Number($('multi-blink-interval').value) : 1000;
const safeName = (name) => String(name || 'FITS').replace(/[<>&"]/g, '');
const absoluteApiUrl = (path) => new URL(path, window.location.origin).href;

function loadAladin() {
    if (aladinReadyPromise) return aladinReadyPromise;
    aladinReadyPromise = new Promise((resolve, reject) => {
        const verify = () => {
            const api = window.A;
            if (!api || typeof api.aladin !== 'function') {
                reject(new Error('Aladin Lite no ha cargado su API.'));
                return;
            }
            Promise.resolve(api.init).then(() => {
                if (typeof api.aladin !== 'function') throw new Error('Aladin Lite terminó de iniciar sin A.aladin.');
                resolve(api);
            }).catch(reject);
        };
        if (window.A && typeof window.A.aladin === 'function') {
            verify();
            return;
        }
        const script = document.createElement('script');
        script.src = 'https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js';
        script.onload = verify;
        script.onerror = () => reject(new Error('No se pudo cargar Aladin Lite v3 estable.'));
        document.head.appendChild(script);
    }).catch(error => {
        aladinReadyPromise = null;
        throw error;
    });
    return aladinReadyPromise;
}

function initSphere() {
    if (state.viewer) return Promise.resolve(state.viewer);
    return loadAladin().then(api => {
        const viewer = api.aladin('#multi-sphere-viewer', {
            survey: 'P/DSS2/color', target: '150.1 2.2', fov: 180,
            projection: $('multi-projection').value || 'SIN', cooFrame: 'ICRS', showCooGrid: true,
            showProjectionControl: true, showLayersControl: true,
            showFullscreenControl: true, showCooLocation: true,
            showReticle: true, mode: 'dark'
        });
        if (!viewer || typeof viewer.displayFITS !== 'function') throw new Error('La versión estable de Aladin Lite no ofrece displayFITS.');
        state.viewer = viewer;
        if (typeof viewer.on === 'function') {
            viewer.on('mouseMove', position => {
                if (!position || !Number.isFinite(position.ra) || !Number.isFinite(position.dec)) return;
                $('multi-cursor-coords').textContent = 'RA ' + position.ra.toFixed(6) + '° · Dec ' + position.dec.toFixed(6) + '°';
            });
        }
        return viewer;
    });
}

function buildPackages(items) {
    const packages = [];
    let current = [], bytes = 0;
    for (const item of items) {
        const size = Number(item.size ?? item.size_bytes ?? 0);
        if (current.length && (current.length >= PACKAGE_FILES || (size > 0 && bytes + size > MAX_PACKAGE_BYTES))) {
            packages.push(current); current = []; bytes = 0;
        }
        current.push(item);
        bytes += size;
    }
    if (current.length) packages.push(current);
    return packages;
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
    const invalid = files.find(file => !/\.(fits?|fts)(\.gz)?$/i.test(file.name) || !file.size || file.size > MAX_BYTES);
    if (invalid) { setStatus('Archivo no válido o superior a 120 MB: ' + invalid.name, 0); return; }
    const packages = buildPackages(files);
    stopBlink();
    $('multi-load-btn').disabled = true;
    let success = 0, failed = 0, completed = 0;
    try {
        const viewer = await initSphere();
        viewer.setProjection($('multi-projection').value);
        for (let packageIndex = 0; packageIndex < packages.length; packageIndex++) {
            const pack = packages[packageIndex];
            setStatus('PAQUETE ' + (packageIndex + 1) + '/' + packages.length + ' · ' + pack.length + ' FITS', completed / files.length * 100);
            for (const file of pack) {
                try {
                    setStatus('Subiendo ' + file.name + ' · ' + (completed + 1) + '/' + files.length, completed / files.length * 100);
                    const result = await uploadFits(file, percent => {
                        setStatus('Paquete ' + (packageIndex + 1) + '/' + packages.length + ' · ' + file.name + ' · ' + Math.round(percent) + '%',
                            ((completed + percent / 100) / files.length) * 100);
                    });
                    if (!result.id || !result.display_url) throw new Error('El backend no devolvió un FITS procesado.');
                    const layerId = 'ylma-multifits-' + result.id;
                    const rendered = await displayLayer(viewer, result, layerId);
                    if (rendered.image && typeof rendered.image.setOpacity === 'function') rendered.image.setOpacity(0.58);
                    state.layers.push({
                        id: layerId, filename: file.name, image: rendered.image,
                        ra: Number.isFinite(rendered.ra) ? rendered.ra : result.ra,
                        dec: Number.isFinite(rendered.dec) ? rendered.dec : result.dec,
                        width: result.width, height: result.height, display_url: result.display_url,
                        visible: true, opacity: 0.58
                    });
                    success++; renderLayerList();
                    if (success === 1 && Number.isFinite(rendered.ra) && Number.isFinite(rendered.dec)) viewer.gotoRaDec(rendered.ra, rendered.dec);
                } catch (error) {
                    failed++;
                    console.error('FITS package item failed: ' + file.name, error);
                } finally {
                    completed++;
                }
            }
        }
        setStatus('Carga local terminada · ' + success + '/' + files.length + ' renderizados · ' + failed + ' errores · ' + packages.length + ' paquetes.', 100);
        $('multi-fits-input').value = '';
    } catch (error) {
        console.error('Multi-FITS load error', error);
        setStatus('No se pudo iniciar la carga: ' + error.message, 0);
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

async function fetchDirectoryTree(raw, recursive = true) {
    const queue = [{path: raw, depth: 0}];
    const visited = new Set();
    const files = [];
    const MAX_DIRECTORIES = 500;
    const MAX_FILES = 5000;
    while (queue.length) {
        const current = queue.shift();
        const normalizedKey = current.path.replace(/\\/$/, '');
        if (visited.has(normalizedKey)) continue;
        visited.add(normalizedKey);
        if (visited.size > MAX_DIRECTORIES) throw new Error('El directorio contiene más de 500 subdirectorios; reduce el alcance.');
        const firstUrl = new URL('/api/catalog', window.location.origin);
        firstUrl.searchParams.set('path', current.path);
        firstUrl.searchParams.set('page', '1');
        firstUrl.searchParams.set('page_size', '100');
        const firstResponse = await fetch(firstUrl);
        const first = await firstResponse.json();
        if (!firstResponse.ok) throw new Error(first.detail || 'IRSA no ha podido listar ' + current.path);
        const dirs = first.directories || [];
        const pages = Math.min(Number(first.fits_pages) || 1, 100);
        for (const file of (first.fits_files || first.observations || [])) {
            files.push({...file, directory_path: current.path});
            if (files.length >= MAX_FILES) throw new Error('Se alcanzó el límite de seguridad de 5.000 FITS por exploración.');
        }
        for (let page = 2; page <= pages; page++) {
            $('multi-directory-summary').textContent = 'Leyendo ' + current.path + ' · página ' + page + '/' + pages;
            const url = new URL('/api/catalog', window.location.origin);
            url.searchParams.set('path', current.path); url.searchParams.set('page', String(page)); url.searchParams.set('page_size', '100');
            const response = await fetch(url);
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.detail || 'No se pudo leer la página ' + page + '.');
            for (const file of (payload.fits_files || payload.observations || [])) {
                files.push({...file, directory_path: current.path});
                if (files.length >= MAX_FILES) throw new Error('Se alcanzó el límite de seguridad de 5.000 FITS por exploración.');
            }
        }
        if (recursive && current.depth < 12) {
            for (const dir of dirs) queue.push({path: dir.path, depth: current.depth + 1});
        }
    }
    return files;
}

async function scanIRsaDirectory() {
    const raw = $('multi-directory-url').value.trim();
    if (!raw) { $('multi-directory-summary').textContent = 'Introduce la URL de una carpeta IRSA.'; return; }
    let parsed;
    try { parsed = new URL(raw); } catch (_) { $('multi-directory-summary').textContent = 'La URL no tiene un formato válido.'; return; }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'irsa.ipac.caltech.edu' ||
        !parsed.pathname.startsWith('/ibe/data/spherex/') || parsed.search || parsed.hash || parsed.username || parsed.password) {
        $('multi-directory-summary').textContent = 'Solo se admiten directorios HTTPS oficiales de IRSA SPHEREx, sin parámetros.';
        return;
    }
    $('multi-directory-scan').disabled = true;
    $('multi-directory-import').disabled = true;
    $('multi-directory-files').replaceChildren();
    const recursive = $('multi-directory-recursive').checked;
    $('multi-directory-summary').textContent = recursive ? 'Explorando el directorio y sus subdirectorios…' : 'Consultando el índice oficial de IRSA…';
    try {
        const all = await fetchDirectoryTree(parsed.href.replace(/\\/$/, ''), recursive);
        const unique = new Map(all.map(file => [file.path, file]));
        state.directoryPath = parsed.href.replace(/\\/$/, '');
        state.directoryFiles = Array.from(unique.values());
        state.importedDirectoryPaths.clear();
        renderDirectoryFiles();
        $('multi-directory-select-all').disabled = state.directoryFiles.length === 0;
        $('multi-directory-select-all').checked = state.directoryFiles.length > 0;
        $('multi-directory-summary').textContent = state.directoryFiles.length + ' FITS encontrados' +
            (recursive ? ' en el árbol completo de directorios' : ' en esta carpeta') +
            (state.directoryFiles.length ? ' · organizados por carpeta en paquetes de 4' : ' · no hay FITS en esta carpeta');
        $('multi-directory-import').disabled = state.directoryFiles.length === 0;
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
    const packages = buildPackages(state.directoryFiles);
    packages.forEach((pack, packageIndex) => {
        const card = document.createElement('section'); card.className = 'multi-directory-package';
        const heading = document.createElement('div'); heading.className = 'multi-directory-package-heading';
        const label = document.createElement('label');
        const packageSelect = document.createElement('input'); packageSelect.type = 'checkbox';
        packageSelect.checked = pack.some(file => !state.importedDirectoryPaths.has(file.path));
        packageSelect.disabled = pack.every(file => state.importedDirectoryPaths.has(file.path));
        packageSelect.setAttribute('aria-label', 'Seleccionar paquete ' + (packageIndex + 1));
        label.append(packageSelect, document.createTextNode('PAQUETE ' + String(packageIndex + 1).padStart(2, '0')));
        const count = document.createElement('small');
        count.textContent = pack.length + ' FITS · ' + (pack.reduce((sum, file) => sum + Number(file.size_bytes || 0), 0) / 1048576).toFixed(1) + ' MB conocidos';
        heading.append(label, count);
        const filesBox = document.createElement('div'); filesBox.className = 'multi-directory-package-files';
        pack.forEach(file => {
            const index = state.directoryFiles.indexOf(file);
            const row = document.createElement('label'); row.className = 'multi-directory-file';
            const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
            const alreadyImported = state.importedDirectoryPaths.has(file.path);
            checkbox.checked = !alreadyImported; checkbox.disabled = alreadyImported;
            checkbox.className = 'multi-directory-file-select'; checkbox.dataset.index = String(index);
            checkbox.addEventListener('change', updateDirectorySelection);
            const text = document.createElement('span'); text.textContent = file.name;
            const meta = document.createElement('small'); meta.textContent = file.size_bytes ? (file.size_bytes / 1048576).toFixed(1) + ' MB' : 'Tamaño no indicado por IRSA';
            text.appendChild(meta); row.append(checkbox, text); filesBox.appendChild(row);
        });
        packageSelect.addEventListener('change', () => {
            filesBox.querySelectorAll('.multi-directory-file-select:not(:disabled)').forEach(input => { input.checked = packageSelect.checked; });
            updateDirectorySelection();
        });
        card.append(heading, filesBox); container.appendChild(card);
    });
    updateDirectorySelection();
}
function updateDirectorySelection() {
    const inputs = Array.from($('multi-directory-files').querySelectorAll('.multi-directory-file-select'));
    const available = inputs.filter(input => !input.disabled);
    const selected = available.filter(input => input.checked).length;
    $('multi-directory-summary').textContent = selected + ' de ' + available.length + ' FITS pendientes seleccionados' +
        (state.importedDirectoryPaths.size ? ' · ' + state.importedDirectoryPaths.size + ' ya incorporados' : '');
    $('multi-directory-import').disabled = selected === 0 || state.importingDirectory;
    const globalSelect = $('multi-directory-select-all');
    globalSelect.disabled = available.length === 0;
    globalSelect.checked = available.length > 0 && selected === available.length;
    globalSelect.indeterminate = selected > 0 && selected < available.length;
    $('multi-directory-files').querySelectorAll('.multi-directory-package').forEach(card => {
        const packageInputs = Array.from(card.querySelectorAll('.multi-directory-file-select'));
        const packageAvailable = packageInputs.filter(input => !input.disabled);
        const packageSelected = packageAvailable.filter(input => input.checked).length;
        const packageCheckbox = card.querySelector('.multi-directory-package-heading input');
        if (packageCheckbox) {
            packageCheckbox.disabled = packageAvailable.length === 0;
            packageCheckbox.checked = packageAvailable.length > 0 && packageSelected === packageAvailable.length;
            packageCheckbox.indeterminate = packageSelected > 0 && packageSelected < packageAvailable.length;
        }
    });
}
async function importDirectorySelection() {
    if (state.importingDirectory) return;
    const selectedIndexes = Array.from($('multi-directory-files').querySelectorAll('.multi-directory-file-select:checked'))
        .map(input => Number(input.dataset.index));
    const selected = selectedIndexes.map(index => state.directoryFiles[index]).filter(Boolean);
    if (!selected.length) return;
    if (!confirm('Se importarán ' + selected.length + ' FITS en paquetes automáticos de hasta 4 archivos. ¿Continuar?')) return;
    state.importingDirectory = true;
    $('multi-directory-import').disabled = true;
    $('multi-directory-scan').disabled = true;
    stopBlink();
    let loaded = 0, failed = 0, finished = 0;
    const byDirectory = new Map();
    selected.forEach(file => {
        const key = file.directory_path || state.directoryPath;
        if (!byDirectory.has(key)) byDirectory.set(key, []);
        byDirectory.get(key).push(file);
    });
    const packages = Array.from(byDirectory.entries()).flatMap(([directory, files]) =>
        buildPackages(files).map(items => ({directory, items}))
    );
    try {
        const viewer = await initSphere();
        viewer.setProjection($('multi-projection').value);
        for (let packageIndex = 0; packageIndex < packages.length; packageIndex++) {
            const pack = packages[packageIndex].items;
            $('multi-directory-summary').textContent = 'Descargando PAQUETE ' + (packageIndex + 1) + '/' + packages.length +
                ' · ' + pack.length + ' archivos · ' + finished + '/' + selected.length + ' completados';
            let payload;
            try {
                const response = await fetch('/api/fits/import-directory', {
                    method: 'POST', headers: {'Content-Type':'application/json'},
                    body: JSON.stringify({directory_path: packages[packageIndex].directory, files: pack.map(file => file.path)})
                });
                payload = await response.json();
                if (!response.ok) throw new Error(payload.detail || 'HTTP ' + response.status);
            } catch (error) {
                failed += pack.length; finished += pack.length;
                console.error('IRSA package ' + (packageIndex + 1) + ' failed', error);
                $('multi-directory-summary').textContent = 'Paquete ' + (packageIndex + 1) + ' fallido: ' + error.message + ' · se continúa con el siguiente.';
                continue;
            }
            for (const result of payload.results || []) {
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
                    loaded++;
                    if (result.source_path) {
                        state.importedDirectoryPaths.add(result.source_path);
                        const sourceCheckbox = $('multi-directory-files').querySelector('.multi-directory-file-select[data-index="' +
                            state.directoryFiles.findIndex(file => file.path === result.source_path) + '"]');
                        if (sourceCheckbox) { sourceCheckbox.checked = false; sourceCheckbox.disabled = true; }
                    }
                    renderLayerList(); updateDirectorySelection();
                    if (loaded === 1 && Number.isFinite(rendered.ra) && Number.isFinite(rendered.dec)) viewer.gotoRaDec(rendered.ra, rendered.dec);
                } catch (error) {
                    failed++; console.warn('No se pudo representar ' + result.filename, error);
                } finally { finished++; }
            }
            const itemErrors = payload.errors || [];
            failed += itemErrors.length; finished += itemErrors.length;
            $('multi-directory-summary').textContent = 'Paquete ' + (packageIndex + 1) + '/' + packages.length +
                ' · ' + loaded + ' FITS en esfera · ' + failed + ' errores · ' + finished + '/' + selected.length + ' procesados';
        }
        setStatus('Importación IRSA terminada · ' + loaded + '/' + selected.length + ' renderizados · ' + failed + ' errores · ' + packages.length + ' paquetes.', 100);
        $('multi-directory-summary').textContent = 'Finalizado: ' + loaded + ' FITS incorporados · ' + failed + ' errores · ' + packages.length + ' paquetes.';
    } catch (error) {
        setStatus('No se pudo iniciar la importación IRSA: ' + error.message, 0);
        $('multi-directory-summary').textContent = error.message;
    } finally {
        state.importingDirectory = false;
        $('multi-directory-scan').disabled = false;
        updateDirectorySelection();
        $('multi-blink-btn').disabled = state.layers.length < 2;
        $('multi-split-btn').disabled = state.layers.length < 2;
    }
}

async function loadWholeDirectoryIntoAladin() {
    const raw = $('multi-stack-url').value.trim();
    let parsed;
    try { parsed = new URL(raw); } catch (_) { $('multi-stack-status').textContent = 'Introduce una URL válida.'; return; }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'irsa.ipac.caltech.edu' ||
        !parsed.pathname.startsWith('/ibe/data/spherex/') || parsed.search || parsed.hash || parsed.username || parsed.password) {
        $('multi-stack-status').textContent = 'Solo se admiten directorios oficiales HTTPS de IRSA SPHEREx.';
        return;
    }
    const accepted = confirm('AVISO DE MEMORIA\\n\\nSe intentará cargar cada FITS del directorio como una capa independiente directamente en Aladin Lite. Los datos se procesarán en el navegador y pueden consumir muchísima RAM, ralentizar el equipo o bloquear/cerrar la pestaña. Para carpetas grandes, usa la importación por paquetes.\\n\\n¿Quieres continuar?');
    if (!accepted) return;
    const button = $('multi-stack-load');
    button.disabled = true;
    $('multi-stack-status').textContent = 'Explorando todos los directorios…';
    try {
        const files = await fetchDirectoryTree(parsed.href.replace(/\\/$/, ''), $('multi-stack-recursive').checked);
        if (!files.length) throw new Error('No se encontraron FITS en esa carpeta.');
        if (!confirm('Se han encontrado ' + files.length + ' FITS. Aladin intentará mantenerlos como capas del navegador. El consumo de RAM puede ser muy elevado. ¿Cargar las ' + files.length + ' capas?')) return;
        stopBlink();
        const viewer = await initSphere();
        viewer.setProjection($('multi-projection').value);
        let loaded = 0, failed = 0;
        for (const file of files) {
            $('multi-stack-status').textContent = 'Aladin Lite · capa ' + (loaded + failed + 1) + '/' + files.length + ' · ' + file.name;
            try {
                const proxyUrl = '/api/fits?path=' + encodeURIComponent(file.path);
                const record = {filename: file.name, display_url: proxyUrl};
                const layerId = 'ylma-aladin-stack-' + loaded + '-' + Date.now();
                const rendered = await displayLayer(viewer, record, layerId);
                state.layers.push({
                    id: layerId, filename: file.name, image: rendered.image,
                    ra: rendered.ra, dec: rendered.dec, width: null, height: null,
                    display_url: proxyUrl, visible: true, opacity: 0.58
                });
                loaded++;
                renderLayerList();
                if (loaded === 1 && Number.isFinite(rendered.ra) && Number.isFinite(rendered.dec)) viewer.gotoRaDec(rendered.ra, rendered.dec);
            } catch (error) {
                failed++;
                console.warn('Aladin direct stack failed: ' + file.path, error);
            }
            $('multi-stack-status').textContent = 'Aladin Lite Stack · ' + loaded + ' capas · ' + failed + ' errores · ' + files.length + ' FITS detectados';
        }
        setStatus('Stack directo finalizado · ' + loaded + ' capas · ' + failed + ' errores.', 100);
    } catch (error) {
        $('multi-stack-status').textContent = 'No se pudo cargar el directorio: ' + error.message;
    } finally {
        button.disabled = false;
        $('multi-blink-btn').disabled = state.layers.length < 2;
        $('multi-split-btn').disabled = state.layers.length < 2;
    }
}

async function importSingleUrl() {
    const input = $('multi-single-url');
    const status = $('multi-single-url-status');
    const raw = input.value.trim();
    let parsed;
    try { parsed = new URL(raw); } catch (_) { status.textContent = 'Introduce una URL válida.'; return; }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'irsa.ipac.caltech.edu' ||
        !parsed.pathname.startsWith('/ibe/data/spherex/') || !/\.(fits?|fts)(\.gz)?$/i.test(parsed.pathname) ||
        parsed.username || parsed.password) {
        status.textContent = 'Solo se admiten URL HTTPS directas de FITS en el archivo oficial SPHEREx de IRSA.';
        return;
    }
    const button = $('multi-single-url-import');
    button.disabled = true;
    status.textContent = 'Descargando y procesando desde IRSA en el servidor…';
    try {
        const response = await fetch('/api/fits/import-url', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({url: parsed.href})
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.detail || 'HTTP ' + response.status);
        const viewer = await initSphere();
        const layerId = 'ylma-multifits-' + payload.id;
        const rendered = await displayLayer(viewer, payload, layerId);
        if (rendered.image && typeof rendered.image.setOpacity === 'function') rendered.image.setOpacity(0.58);
        state.layers.push({
            id: layerId, filename: payload.filename, image: rendered.image,
            ra: Number.isFinite(rendered.ra) ? rendered.ra : payload.ra,
            dec: Number.isFinite(rendered.dec) ? rendered.dec : payload.dec,
            width: payload.width, height: payload.height, display_url: payload.display_url,
            visible: true, opacity: 0.58
        });
        renderLayerList();
        if (state.layers.length === 1 && Number.isFinite(rendered.ra) && Number.isFinite(rendered.dec)) viewer.gotoRaDec(rendered.ra, rendered.dec);
        status.textContent = 'FITS incorporado y renderizado: ' + payload.filename;
        setStatus('URL IRSA incorporada correctamente.', 100);
    } catch (error) {
        status.textContent = 'Error al importar URL: ' + error.message;
    } finally {
        button.disabled = false;
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
$('multi-single-url-import').addEventListener('click', importSingleUrl);
$('multi-stack-load').addEventListener('click', loadWholeDirectoryIntoAladin);
$('multi-directory-select-all').addEventListener('change', () => {
    $('multi-directory-files').querySelectorAll('.multi-directory-file-select:not(:disabled)').forEach(input => { input.checked = $('multi-directory-select-all').checked; });
    updateDirectorySelection();
});
window.addEventListener('beforeunload', () => stopBlink(false));
})();