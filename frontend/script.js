// YLMA SPHEREx Explorer — same-origin API and archive-backed observations only.
let aladin = null;
let aladinLeft = null;
let aladinRight = null;
let isSplitMode = false;
let blinkInterval = null;
let isBlinkingActive = false;
let observations = [];
let requestController = null;
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
        observations = Array.isArray(payload.observations) ? payload.observations : [];
        state.currentIndex = 0;
        state.splitIndexLeft = 0;
        state.splitIndexRight = Math.max(0, observations.length - 1);
        updateObservationControls();
        const demo = payload.is_demo === true;
        const source = payload.source || 'Fuente no especificada';
        const badge = byId('demo-indicator');
        if (badge) {
            badge.textContent = demo ? 'MODO DEMO — DATOS NO CIENTÍFICOS' : 'FUENTE: IRSA/IPAC TAP';
            badge.setAttribute('aria-label', source);
        }
        setObservationStatus(demo ? 'DEMO — no son observaciones científicas reales.' : 'Conectado a IRSA/IPAC TAP',
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
        if (badge) badge.textContent = 'IRSA NO DISPONIBLE';
        renderObservationList('IRSA no está disponible. No se muestran datos simulados como resultados.');
        if (aladin) aladin.setImageSurvey('P/DSS2/color');
    }
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
        return url.protocol === 'https:' && url.hostname === 'irsa.ipac.caltech.edu' ? url.href : null;
    } catch { return null; }
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
    if (url && aladin && byId('layer-fits')?.classList.contains('active')) {
        try { aladin.displayImage(url, { name: label }); }
        catch (error) { console.warn('Aladin cannot display this archive product', error); }
    } else if (aladin && !byId('layer-fits')?.classList.contains('active')) {
        aladin.setImageSurvey('P/DSS2/color');
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
    if (!observations.length) {
        setObservationStatus('La vista dividida requiere al menos una observación devuelta por IRSA.', '');
        return;
    }
    isSplitMode = !isSplitMode;
    byId('btn-split')?.classList.toggle('active', isSplitMode);
    byId('aladin-lite-div').style.display = isSplitMode ? 'none' : 'block';
    byId('normal-timeline').style.display = isSplitMode ? 'none' : 'flex';
    byId('split-view-container').style.display = isSplitMode ? 'grid' : 'none';
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
    const url = observationUrl(item);
    if (url) {
        try { viewer.displayImage(url, { name: observationLabel(item) }); }
        catch (error) { console.warn('Unable to display IRSA product in Aladin', error); }
    } else viewer.setImageSurvey('P/DSS2/color');
}

function toggleBlink() {
    if (isBlinkingActive) { stopBlink(); return; }
    if (observations.length < 2) {
        const label = byId('blink-status-label');
        if (label) label.textContent = 'Se requieren dos observaciones reales para comparar.';
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
        const url = item && observationUrl(item);
        if (url && aladin) {
            try { aladin.displayImage(url, { name: observationLabel(item) }); }
            catch (error) { console.warn('Blink product display failed', error); }
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
