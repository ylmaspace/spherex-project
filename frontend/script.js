// YLMA SPHEREx Explorer — same-origin API and archive-backed observations only.
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
    setObservationStatus('Independent FITS viewer ready. Load a local FITS file to begin.', 'LOCAL MODE');
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
    byId('explore-btn')?.addEventListener('click', () => {
        byId('landing-view').classList.remove('active');
        byId('explorer-view').classList.add('active');
        setObservationStatus('Local FITS viewer ready. Upload a FITS file to begin.', 'LOCAL MODE');
        if (byId('demo-indicator')) byId('demo-indicator').textContent = 'LOCAL FITS MODE · NO IRSA / CDS REQUIRED';
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
        await searchObservations();
    });
    byId('layer-real')?.addEventListener('click', async () => {
        setActiveLayer('layer-real');
        await searchObservations();
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
    byId('blink-interval')?.addEventListener('change', () => {
        if (!isBlinkingActive) return;
        stopBlink();
        toggleBlink();
    });
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
        // Local split comparison is controlled by the two FITS preview panes.
    });
    byId('split-index-right')?.addEventListener('change', (event) => {
        const index = parseObservationIndex(event.target.value);
        if (index === null) { event.target.value = String(state.splitIndexRight + 1); return; }
        state.splitIndexRight = index;
        event.target.value = String(index + 1);
        // Local split comparison is controlled by the two FITS preview panes.
    });
}

function applyLocalFitsTransform() {
    const image = byId('fits-local-image');
    if (image) image.style.transform = 'translate(' + localFitsPan.x + 'px, ' + localFitsPan.y + 'px) scale(' + localFitsZoom + ')';
}
function initLocalFitsControls() {
    const viewport = byId('fits-local-viewport'); const image = byId('fits-local-image');
    byId('fits-local-reset')?.addEventListener('click', () => { localFitsZoom = 1; localFitsPan = {x:0,y:0}; applyLocalFitsTransform(); });
    viewport?.addEventListener('mousemove', (event) => {
        if (!image?.naturalWidth || !image?.naturalHeight) return;
        const rect = image.getBoundingClientRect();
        const readout = byId('fits-local-pixel-coords');
        if (!rect.width || !rect.height) return;
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
            if (readout) readout.textContent = 'PIXEL X — · Y —';
            return;
        }
        const x = Math.min(image.naturalWidth - 1, Math.floor((event.clientX - rect.left) / rect.width * image.naturalWidth));
        const y = Math.min(image.naturalHeight - 1, Math.floor((event.clientY - rect.top) / rect.height * image.naturalHeight));
        if (readout) readout.textContent = 'PIXEL X ' + x + ' · Y ' + y;
    });
    viewport?.addEventListener('mouseleave', () => {
        const readout = byId('fits-local-pixel-coords');
        if (readout) readout.textContent = 'PIXEL X — · Y —';
    });
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
        request.onerror = () => reject(request.error || new Error('Could not open local storage.'));
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

function showFitsProgress(title, message, percent = 0, indeterminate = false) {
    const overlay = byId('fits-progress-overlay');
    if (!overlay) return;
    overlay.classList.add('active');
    overlay.classList.toggle('is-processing', Boolean(indeterminate));
    overlay.setAttribute('aria-hidden', 'false');
    if (byId('fits-progress-title')) byId('fits-progress-title').textContent = title;
    if (byId('fits-progress-message')) byId('fits-progress-message').textContent = message;
    const progressBar = byId('fits-progress-bar');
    if (progressBar) progressBar.style.width = indeterminate ? '36%' : `${percent}%`;
    if (byId('fits-progress-percent')) byId('fits-progress-percent').textContent =
        indeterminate ? 'SERVER' : `${Math.round(percent)}%`;
}

function hideFitsProgress() {
    const overlay = byId('fits-progress-overlay');
    overlay?.classList.remove('active', 'is-processing');
    overlay?.setAttribute('aria-hidden', 'true');
}

function renderSavedSkyMap() {
    const list = byId('saved-sky-list');
    if (!list) return;
    list.replaceChildren();
    if (byId('saved-sky-summary')) byId('saved-sky-summary').textContent =
        `${savedSkyRecords.length} image(s) added to the map`;
    if (!savedSkyRecords.length) {
        const empty = document.createElement('p');
        empty.className = 'doc-text';
        empty.textContent = 'You have not saved any images yet.';
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
            else setObservationStatus('The original file is not available in this browser.', '');
        });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'REMOVE FROM MAP';
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
    // Aladin catalog markers are exclusive to Multi-FITS Lab.
}

async function uploadFitsToBackend(file, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        let processingTimer = null;
        let processingStartedAt = 0;
        const clearProcessingTimer = () => {
            if (processingTimer) clearInterval(processingTimer);
            processingTimer = null;
        };
        const report = (percent, stage, message) => {
            if (typeof onProgress === 'function') onProgress(percent, { stage, message });
        };
        xhr.open('POST', '/api/fits/upload');
        xhr.timeout = 12 * 60 * 1000;
        xhr.responseType = 'json';
        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
                report(Math.min(72, event.loaded / event.total * 72), 'uploading',
                    'Uploading ' + file.name + ' · ' + (event.loaded / 1048576).toFixed(1) + ' / ' +
                    (event.total / 1048576).toFixed(1) + ' MB');
            }
        };
        xhr.upload.onload = () => {
            processingStartedAt = Date.now();
            report(76, 'processing',
                'Upload complete. The server is inspecting FITS extensions, reading image data and generating the preview. Keep this tab open.');
            processingTimer = setInterval(() => {
                const elapsed = Math.floor((Date.now() - processingStartedAt) / 1000);
                const minutes = Math.floor(elapsed / 60);
                const seconds = String(elapsed % 60).padStart(2, '0');
                report(76, 'processing',
                    'The server is still processing ' + file.name + ' · elapsed ' + minutes + ':' + seconds +
                    '. Large FITS files can take longer.');
            }, 10000);
        };
        xhr.onload = () => {
            clearProcessingTimer();
            let payload = xhr.response;
            if (!payload || typeof payload !== 'object') {
                try { payload = JSON.parse(xhr.responseText || '{}'); } catch (_) { payload = {}; }
            }
            if (xhr.status >= 200 && xhr.status < 300) {
                report(84, 'server-ready', 'Server processing complete. Preparing the image in your browser…');
                resolve(payload);
            } else {
                reject(new Error(payload.detail || payload.message || `The server responded with HTTP ${xhr.status}.`));
            }
        };
        xhr.onerror = () => {
            clearProcessingTimer();
            reject(new Error('The connection was interrupted while the server was processing the FITS file. Check your connection and try again.'));
        };
        xhr.ontimeout = () => {
            clearProcessingTimer();
            reject(new Error('The server took more than 12 minutes to process the FITS file. Check the server logs; the upload was cancelled.'));
        };
        xhr.onabort = () => {
            clearProcessingTimer();
            reject(new Error('The FITS upload was cancelled.'));
        };
        const form = new FormData();
        form.append('file', file, file.name || 'observation.fits');
        report(2, 'uploading', 'Preparing ' + file.name + '…');
        xhr.send(form);
    });
}

async function loadFitsFromUrl() {
    const input = byId('fits-url-input');
    const rawUrl = String(input?.value || '').trim();
    if (!rawUrl) {
        setObservationStatus('Paste a direct URL to an IRSA FITS file.', 'URL necesaria');
        input?.focus();
        return;
    }
    let source;
    try {
        source = new URL(rawUrl);
    } catch (_) {
        setObservationStatus('The URL format is invalid.', 'Invalid URL');
        return;
    }
    if (source.protocol !== 'https:' || source.hostname !== 'irsa.ipac.caltech.edu' ||
        source.username || source.password || source.search || source.hash ||
        !source.pathname.startsWith('/ibe/data/spherex/') || !/\.(fits?|fts)$/i.test(source.pathname)) {
        setObservationStatus('Only direct HTTPS links to FITS files in the IRSA SPHEREx archive are supported.', 'URL no admitida');
        return;
    }
    const filename = source.pathname.split('/').pop() || 'spherex-observation.fits';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8 * 60 * 1000);
    try {
        showFitsProgress('RECUPERANDO FITS DESDE IRSA', filename, 5);
        setObservationStatus('Requesting the file directly from IRSA…', 'Remote download');
        const proxyUrl = '/api/product?' + new URLSearchParams({ url: source.href }).toString();
        const response = await fetch(proxyUrl, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) {
            let detail = 'IRSA returned HTTP ' + response.status + '.';
            try { const payload = await response.json(); if (payload.detail) detail = payload.detail; } catch (_) {}
            throw new Error(detail);
        }
        const declaredSize = Number(response.headers.get('content-length') || 0);
        if (declaredSize > 120 * 1024 * 1024) throw new Error('The FITS file exceeds the 120 MB limit.');
        showFitsProgress('DOWNLOADING FITS FROM IRSA', filename, 45);
        const reader = response.body?.getReader();
        if (!reader) throw new Error('The browser cannot read the IRSA download.');
        const chunks = [];
        let received = 0;
        try {
            while (true) {
                const part = await reader.read();
                if (part.done) break;
                received += part.value.byteLength;
                if (received > 120 * 1024 * 1024) {
                    await reader.cancel();
                    throw new Error('The FITS file exceeds the 120 MB limit.');
                }
                chunks.push(part.value);
                const percent = declaredSize > 0
                    ? Math.min(75, 45 + received / declaredSize * 30)
                    : Math.min(70, 45 + received / (120 * 1024 * 1024) * 25);
                showFitsProgress('DOWNLOADING FITS FROM IRSA', filename + ' · ' + (received / 1048576).toFixed(1) + ' MB', percent);
            }
        } finally {
            reader.releaseLock();
        }
        if (!received) throw new Error('IRSA returned an empty file.');
        const blob = new Blob(chunks, { type: response.headers.get('content-type') || 'application/fits' });
        if (blob.type.includes('text/html')) throw new Error('IRSA returned a web page instead of a FITS file.');
        showFitsProgress('PROCESSING REMOTE FITS', filename + ' · ' + (blob.size / 1048576).toFixed(1) + ' MB', 78);
        const file = new File([blob], filename, { type: 'application/fits', lastModified: Date.now() });
        const loaded = await loadLocalFits(file);
        if (loaded) {
            setObservationStatus('Remote FITS added successfully: ' + filename, (blob.size / 1048576).toFixed(1) + ' MB · IRSA');
            if (input) input.value = source.href;
        }
    } catch (error) {
        hideFitsProgress();
        console.error('Remote FITS import failed', error);
        const message = error.name === 'AbortError' ? 'The IRSA download exceeded 8 minutes and was cancelled.' : error.message;
        setObservationStatus('Could not add FITS from URL: ' + message, 'Remote load error');
    } finally {
        clearTimeout(timeout);
    }
}

async function loadComparisonFits(file) {
    if (!activeLocalFitsUrl) {
        setObservationStatus('Load the primary FITS image first; then you can add a second image for comparison.', '');
        return;
    }
    if (!/\.(fits?|fts)$/i.test(file.name || '') || !file.size || file.size > 120 * 1024 * 1024) {
        setObservationStatus('Select a valid FITS file up to 120 MB.', 'Invalid file');
        return;
    }
    try {
        showFitsProgress('LOADING SECOND IMAGE', 'Processing ' + file.name + '…', 0);
        const result = await uploadFitsToBackend(file, (percent, phase) => {
            const processing = phase?.stage === 'processing';
            showFitsProgress(
                processing ? 'PROCESSING SECOND FITS ON SERVER' : 'UPLOADING SECOND IMAGE',
                phase?.message || file.name, percent, processing
            );
        });
        if (!result?.id || !result.preview_url) throw new Error('The server did not return a valid preview.');
        showFitsProgress('PREPARING COMPARISON', 'Downloading the second image…', 90);
        const response = await fetch(result.preview_url, { cache: 'no-store' });
        if (!response.ok) throw new Error('The preview returned HTTP ' + response.status + '.');
        const blob = await response.blob();
        if (!blob.size || !blob.type.startsWith('image/')) throw new Error('The server did not return a valid image preview.');
        const nextUrl = URL.createObjectURL(blob);
        const probe = new Image();
        try {
            await new Promise((resolve, reject) => {
                probe.onload = resolve;
                probe.onerror = () => reject(new Error('The browser could not decode the second FITS preview.'));
                probe.src = nextUrl;
            });
            if (!probe.naturalWidth || !probe.naturalHeight) {
                throw new Error('The second FITS image has invalid dimensions.');
            }
        } catch (previewError) {
            URL.revokeObjectURL(nextUrl);
            throw previewError;
        }
        if (comparisonLocalFitsUrl) URL.revokeObjectURL(comparisonLocalFitsUrl);
        comparisonLocalFitsUrl = nextUrl;
        comparisonLocalFitsName = file.name;
        blinkLocalShowingSecond = false;
        const controls = byId('compare-fits-btn');
        if (controls) controls.textContent = 'CHANGE COMPARISON FITS';
        const blinkLabel = byId('blink-status-label');
        if (blinkLabel) blinkLabel.textContent = 'Image A: ' + (byId('fits-local-title')?.textContent || 'Primary FITS');
        renderLocalSplitComparison();
        setObservationStatus('Second image ready for comparison: ' + file.name, result.width + '×' + result.height);
        showFitsProgress('COMPARISON READY', 'Ya puedes usar Parpadear o Vista dividida.', 100);
        setTimeout(hideFitsProgress, 700);
        if (pendingLocalCompareMode === 'split') {
            pendingLocalCompareMode = null;
            if (!isSplitMode) toggleSplitView();
        }
    } catch (error) {
        hideFitsProgress();
        console.error('FITS comparison upload failed', error);
        setObservationStatus('Could not load the second image: ' + error.message, 'Comparison error');
    }
}

function renderLocalSplitComparison() {
    const left = byId('split-local-left');
    const right = byId('split-local-right');
    const leftTitle = byId('split-local-left-title');
    const rightTitle = byId('split-local-right-title');
    if (!left || !right || !activeLocalFitsUrl || !comparisonLocalFitsUrl) return false;

    // Both panes are fed by the two user-selected FITS previews.
    left.src = activeLocalFitsUrl;
    right.src = comparisonLocalFitsUrl;
    if (leftTitle) leftTitle.textContent = byId('fits-local-title')?.textContent || 'FITS A';
    if (rightTitle) rightTitle.textContent = comparisonLocalFitsName || 'FITS B';
    return true;
}

function updateSkyCoordinates(result) {
    const ra = Number(result.ra), dec = Number(result.dec);
    if (result.ra === null || result.ra === undefined || result.dec === null || result.dec === undefined || !Number.isFinite(ra) || !Number.isFinite(dec)) {
        if (byId('info-radec')) byId('info-radec').textContent = 'WCS is not available in this FITS file';
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
    return true;
}

async function loadLocalFitsBatch(files) {
    const fitsFiles = files.filter((file) => /\.(fits?|fts)$/i.test(file.name || ''));
    if (!fitsFiles.length) {
        setObservationStatus('No valid FITS files were found in the selection.', '');
        return;
    }
    let succeeded = 0;
    for (let index = 0; index < fitsFiles.length; index += 1) {
        showFitsProgress('CREANDO TU MAPA CELESTE', `Processing image ${index + 1} of ${fitsFiles.length}: ${fitsFiles[index].name}`, 0);
        if (await loadLocalFits(fitsFiles[index])) succeeded += 1;
    }
    hideFitsProgress();
    setObservationStatus(
        `Upload complete: ${succeeded} of ${fitsFiles.length} FITS files added.`,
        `${savedSkyRecords.length} saved images`
    );
}

async function loadLocalFits(file, existingRecordId = null) {
    const name = String(file?.name || 'observation.fits');
    if (!/\.(fits?|fts)$/i.test(name)) {
        setObservationStatus('Invalid format. Select an uncompressed FITS file.', '');
        return;
    }
    if (file.size > 120 * 1024 * 1024) {
        setObservationStatus('The file exceeds the 120 MB limit.', '');
        return;
    }
    if (!file.size) {
        setObservationStatus('The selected file is empty.', '');
        return;
    }
    const token = ++fitsLoadToken;
    try {
        showFitsProgress('INCORPORANDO FITS IMAGE', 'Subiendo ' + name + '…', 0);
        setObservationStatus('Preparando FITS: ' + name, 'Procesando');
        const result = await uploadFitsToBackend(file, (percent, phase) => {
            const processing = phase?.stage === 'processing';
            showFitsProgress(
                processing ? 'PROCESSING FITS ON SERVER' : 'UPLOADING FILE',
                phase?.message || (name + ' · ' + (file.size / 1048576).toFixed(1) + ' MB'),
                percent, processing
            );
        });
        if (!result || !result.id || !result.preview_url || !Number(result.width) || !Number(result.height)) {
            throw new Error('The server did not return a valid FITS preview.');
        }
        showFitsProgress('DECODING SCIENCE DATA', 'Reading HDU, image data, and WCS coordinates…', 84);
        if (token !== fitsLoadToken) return false;
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
        // Rendering the FITS preview is independent from the optional IndexedDB sky map.
        const image = byId('fits-local-image');
        const localViewer = byId('fits-local-viewer');
        if (!image || !localViewer) throw new Error('Local FITS viewer not found.');
        showFitsProgress('RENDERING IMAGE', 'Downloading the processed preview…', 92);
        const previewResponse = await fetch(result.preview_url, { cache: 'no-store' });
        if (!previewResponse.ok) throw new Error('The server processed the FITS file, but the preview returned HTTP ' + previewResponse.status + '.');
        const previewBlob = await previewResponse.blob();
        if (!previewBlob.type.includes('image/')) throw new Error('The preview response is not an image.');
        if (token !== fitsLoadToken) return false;
        const previewObjectUrl = URL.createObjectURL(previewBlob);
        const previousUrl = activeLocalFitsUrl;
        try {
            image.src = previewObjectUrl;
            if (image.decode) await image.decode();
            else await new Promise((resolve, reject) => {
                image.onload = resolve;
                image.onerror = () => reject(new Error('The browser could not decode the FITS image.'));
            });
        } catch (decodeError) {
            if (previousUrl) image.src = previousUrl;
            else image.removeAttribute('src');
            URL.revokeObjectURL(previewObjectUrl);
            throw new Error('The FITS preview was generated, but the browser could not display it: ' + decodeError.message);
        }
        if (token !== fitsLoadToken) {
            URL.revokeObjectURL(previewObjectUrl);
            if (previousUrl) image.src = previousUrl;
            return false;
        }
        activeLocalFitsUrl = previewObjectUrl;
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        localFitsZoom = 1;
        localFitsPan = { x: 0, y: 0 };
        applyLocalFitsTransform();
        byId('fits-local-title').textContent = name;
        byId('fits-local-coords').textContent = hasWcs
            ? 'RA ' + Number(result.ra).toFixed(5) + '° · Dec ' + Number(result.dec).toFixed(5) + '°'
            : 'No WCS data · image displayed without sky coordinates';
        localViewer.hidden = false;
        let savedToSkyMap = true;
        try {
            await saveSkyRecord(record);
            savedSkyRecords = await getSavedSkyRecords();
            renderSavedSkyMap();
        } catch (saveError) {
            savedToSkyMap = false;
            console.warn('FITS rendered, but the optional sky-map save failed:', saveError);
        }
        setActiveLayer('layer-fits');
        if (byId('info-epoch-label')) byId('info-epoch-label').textContent = name;
        if (byId('hud-survey')) byId('hud-survey').textContent = hasWcs ? 'FITS LOCAL · WCS' : 'FITS LOCAL · SIN WCS';
        if (byId('timeline-epoch-title')) byId('timeline-epoch-title').textContent = name;
        if (byId('fits-dropzone')) byId('fits-dropzone').classList.add('fits-loaded');
        setObservationStatus(
            savedToSkyMap ? 'FITS image rendered and saved: ' + name : 'FITS image rendered: ' + name + ' · not saved to the optional sky map',
            'HDU ' + result.hdu_index + ' · ' + result.width + '×' + result.height + (hasWcs ? '' : ' · sin WCS')
        );
        showFitsProgress('IMAGE ADDED', 'The image is already visible in the local viewer.', 100);
        setTimeout(hideFitsProgress, 650);
        return true;
    } catch (error) {
        hideFitsProgress();
        console.error('FITS upload failed', error);
        setObservationStatus('Could not add FITS file: ' + error.message, 'Load error');
        return false;
    }
}

async function loadRemoteObservationFits(item) {
    const sourceUrl = observationUrl(item);
    if (!sourceUrl) { setObservationStatus('This observation has no direct SPHEREx FITS product URL.', 'No FITS product'); return; }
    const input = byId('fits-url-input');
    if (input) input.value = sourceUrl;
    await loadFitsFromUrl();
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

// Aladin Lite is not loaded by the main Explorer. It is isolated to Multi-FITS Lab.

async function searchObservations() {
    if (requestController) requestController.abort();
    requestController = new AbortController();
    setObservationStatus('Querying the IRSA archive…', 'Cargando');
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
            badge.textContent = demo ? 'DEMO MODE — NON-SCIENTIFIC DATA' : 'FUENTE: IRSA SIA2 DR1 + QR3';
            badge.setAttribute('aria-label', source);
        }
        setObservationStatus(demo ? 'DEMO — these are not real scientific observations.' : 'Conectado a IRSA SIA2 · producto FITS seleccionable',
            `${payload.count ?? observations.length} observation(s)`);
        updateSkyPosition();
        renderObservationList();
        showSelectedObservation();
    } catch (error) {
        if (error.name === 'AbortError') return;
        observations = [];
        updateObservationControls();
        setObservationStatus(`Could not query observations: ${error.message}`, 'Sin resultados disponibles');
        const badge = byId('demo-indicator');
        if (badge) badge.textContent = 'LOCAL FITS MODE · IRSA UNAVAILABLE';
        renderObservationList('IRSA is unavailable. Simulated data is not shown as real results.');
    }
}

async function loadCatalog() {
    const path = byId('catalog-path')?.value.trim() || '';
    const status = byId('catalog-status');
    const results = byId('catalog-results');
    if (status) status.textContent = 'Connecting to the official SPHEREx directory at IRSA…';
    if (results) results.replaceChildren();
    const params = new URLSearchParams({ path, page: '1', page_size: '100' });
    try {
        const response = await fetch('/api/catalog?' + params);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.detail || 'Error HTTP ' + response.status);
        catalogEntries = [...(payload.directories || []), ...(payload.files || payload.observations || [])];
        if (status) status.textContent = catalogEntries.length + ' elemento(s) en ' + (payload.path || 'SPHEREx root') + ' · Los FITS se descargan desde IRSA.';
        renderCatalogEntries(catalogEntries);
    } catch (error) {
        catalogEntries = [];
        if (status) status.textContent = 'Could not open this directory: ' + error.message + '. Check the URL or try again later.';
        if (results) {
            const link = document.createElement('a');
            link.href = 'https://irsa.ipac.caltech.edu/ibe/data/spherex/';
            link.target = '_blank';
            link.rel = 'noopener';
            link.textContent = 'Open the SPHEREx archive directly at IRSA';
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
        empty.textContent = 'This directory contains no visible items.';
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
        main.setAttribute('aria-label', max ? `Observation number, from 1 to ${max}` : 'No hay observaciones');
    }
    [['split-index-left', state.splitIndexLeft], ['split-index-right', state.splitIndexRight]].forEach(([id, index]) => {
        const input = byId(id);
        if (!input) return;
        input.value = max ? String(Math.min(Number(index) + 1, max)) : '';
        input.placeholder = max ? `1–${max}` : 'No data';
        input.disabled = max === 0;
    });
}

function observationLabel(item) {
    return item.obs_id || item.obs_publisher_did || item.target_name || 'Identifier unavailable';
}

function observationDate(item) {
    return item.t_min ?? item.date_obs ?? item.obs_date ?? 'Date unavailable';
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
        if (byId('info-epoch-label')) byId('info-epoch-label').textContent = 'No observation selected';
        if (byId('hud-survey')) byId('hud-survey').textContent = 'No SPHEREx product loaded';
        if (byId('timeline-epoch-title')) byId('timeline-epoch-title').textContent = 'No observation selected';
        if (byId('hud-time-display')) byId('hud-time-display').textContent = '—';
        return;
    }
    const label = observationLabel(item), date = observationDate(item);
    if (byId('info-epoch-label')) byId('info-epoch-label').textContent = label;
    if (byId('timeline-epoch-title')) byId('timeline-epoch-title').textContent = `OBSERVATION: ${label}`;
    if (byId('hud-time-display')) byId('hud-time-display').textContent = String(date);
    if (byId('hud-survey')) byId('hud-survey').textContent = `IRSA FITS: ${label}`;
    updateSkyPosition();
    if (observationUrl(item)) loadRemoteObservationFits(item);
    else setObservationStatus('The selected observation has no downloadable FITS product.', 'No FITS product');
}

function renderObservationList(message = '') {
    const container = byId('objects-list-container');
    if (!container) return;
    container.replaceChildren();
    if (message || observations.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'doc-text';
        empty.textContent = message || 'No IRSA observations were found for this search.';
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
    if (!activeLocalFitsUrl) {
        setObservationStatus('Load a primary local FITS image first.', '');
        byId('local-fits-input')?.click(); return;
    }
    if (!comparisonLocalFitsUrl) {
        pendingLocalCompareMode = 'split';
        setObservationStatus('Select a second FITS image to compare in split view.', '');
        byId('compare-fits-input')?.click(); return;
    }
    isSplitMode = !isSplitMode;
    byId('btn-split')?.classList.toggle('active', isSplitMode);
    byId('visor-stage')?.classList.toggle('local-split-active', isSplitMode);
    // The primary viewer is the left pane in split mode; keep it visible.
    if (byId('fits-local-viewer')) byId('fits-local-viewer').hidden = false;
    if (byId('split-local-container')) byId('split-local-container').style.display = isSplitMode ? 'block' : 'none';
    if (byId('normal-timeline')) byId('normal-timeline').style.display = isSplitMode ? 'none' : 'flex';
    if (isSplitMode) renderLocalSplitComparison();
}

function toggleBlink() {
    if (isBlinkingActive) { stopBlink(); return; }
    if (!activeLocalFitsUrl || !comparisonLocalFitsUrl) {
        const label = byId('blink-status-label');
        if (label) label.textContent = 'Load two local FITS images to start blink comparison.';
        if (!activeLocalFitsUrl) byId('local-fits-input')?.click();
        else byId('compare-fits-input')?.click();
        return;
    }
    isBlinkingActive = true;
    const button = byId('blink-start-toggle');
    if (button) button.textContent = 'STOP BLINK';
    const preview = byId('blink-local-image');
    if (preview) {
        preview.src = activeLocalFitsUrl; preview.style.display = 'block';
        preview.style.width = '100%'; preview.style.height = '100%'; preview.style.objectFit = 'contain';
    }
    let showSecond = false;
    const blinkOnce = () => {
        showSecond = !showSecond; blinkLocalShowingSecond = showSecond;
        if (preview) preview.src = showSecond ? comparisonLocalFitsUrl : activeLocalFitsUrl;
        const label = byId('blink-status-label');
        if (label) label.textContent = showSecond ? 'IMAGE B: ' + comparisonLocalFitsName :
            'IMAGE A: ' + (byId('fits-local-title')?.textContent || 'Primary FITS');
    };
    blinkOnce(); blinkInterval = setInterval(blinkOnce, getBlinkIntervalMs());
}
function getBlinkIntervalMs() {
    const value = Number(byId('blink-interval')?.value || 1000);
    return [2000, 1000, 500, 333].includes(value) ? value : 1000;
}

function stopBlink() {
    isBlinkingActive = false;
    if (blinkInterval) clearInterval(blinkInterval);
    blinkInterval = null;
    blinkLocalShowingSecond = false;
    const button = byId('blink-start-toggle');
    if (button) button.textContent = 'START BLINK';
    const preview = byId('blink-local-image');
    if (preview && activeLocalFitsUrl) preview.src = activeLocalFitsUrl;
    const label = byId('blink-status-label');
    if (label && activeLocalFitsUrl) label.textContent = 'IMAGE A: ' + (byId('fits-local-title')?.textContent || 'Primary FITS');
}

function toggleFullscreen() {
    const stage = byId('visor-stage');
    if (!document.fullscreenElement) stage?.requestFullscreen().catch((error) => console.warn('Fullscreen unavailable', error));
    else document.exitFullscreen().catch((error) => console.warn('Could not exit fullscreen', error));
}
