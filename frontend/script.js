// YLMA SPHEREx Explorer - Stellarium Web & FastAPI Backend Integration
let state = {
    userId: localStorage.getItem('ylma_user_id') || 'YLMA-USER-2026',
    currentRA: 150.1,
    currentDec: 2.2,
    currentRadius: 45,
    // Épocas reales con fechas, horas y marcas de tiempo UTC para Stellarium
    epochs: [
        { label: "30 SEP 2026", time: "15:31:00", dateStr: "2026-09-30T15:31:00Z" },
        { label: "15 JUN 2026", time: "11:10:25", dateStr: "2026-06-15T11:10:25Z" },
        { label: "01 MAR 2026", time: "08:45:00", dateStr: "2026-03-01T08:45:00Z" },
        { label: "12 ENE 2026", time: "02:00:15", dateStr: "2026-01-12T02:00:15Z" }
    ],
    currentEpochIndex: 0
};

document.addEventListener('DOMContentLoaded', () => {
    initUser();
    setupEventListeners();
});

function initUser() {
    const badge = document.getElementById('user-session-badge');
    if (badge) badge.innerText = state.userId;
}

function setupEventListeners() {
    document.getElementById('explore-btn').addEventListener('click', () => {
        document.getElementById('landing-view').classList.remove('active');
        document.getElementById('explorer-view').classList.add('active');
        
        // Carga inicial de datos del backend
        fetchBackendObservations(state.currentRA, state.currentDec, state.currentRadius);
    });

    document.getElementById('back-home').addEventListener('click', () => {
        document.getElementById('explorer-view').classList.remove('active');
        document.getElementById('landing-view').classList.add('active');
    });

    // Formulario de búsqueda principal
    document.getElementById('search-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const raVal = parseFloat(document.getElementById('input-ra').value);
        const decVal = parseFloat(document.getElementById('input-dec').value);
        const radVal = parseFloat(document.getElementById('input-radius').value) || 45;

        state.currentRA = raVal;
        state.currentDec = decVal;
        state.currentRadius = radVal;

        updateStellariumView();
        fetchBackendObservations(raVal, decVal, radVal);
    });

    // Pantalla completa
    document.getElementById('btn-fs').addEventListener('click', () => {
        const stage = document.getElementById('visor-stage');
        if (!document.fullscreenElement) stage.requestFullscreen().catch(err => console.error(err));
        else document.exitFullscreen();
    });

    // Modal de Objetos Visibles
    document.getElementById('nav-objects-btn').addEventListener('click', () => {
        document.getElementById('objects-modal').classList.add('active');
        fetchBackendObservationsForModal(state.currentRA, state.currentDec, state.currentRadius);
    });
    document.getElementById('objects-close-btn').addEventListener('click', () => {
        document.getElementById('objects-modal').classList.remove('active');
    });

    // CONTROL DESLIZANTE INFERIOR: Actualiza época, hora local, visor de Stellarium y backend
    const epochRange = document.getElementById('epoch-range');
    if (epochRange) {
        epochRange.max = state.epochs.length - 1;
        epochRange.addEventListener('input', (e) => {
            const index = parseInt(e.target.value);
            state.currentEpochIndex = index;
            applyEpoch(index);
        });
    }
}

function applyEpoch(index) {
    const epoch = state.epochs[index];
    if (!epoch) return;

    // 1. Actualizar textos de hora y fecha en el HUD inferior
    document.getElementById('timeline-epoch-title').innerText = `ÉPOCA: ${epoch.label}`;
    document.getElementById('hud-time-display').innerText = epoch.time;
    document.getElementById('info-epoch-label').innerText = `${epoch.label} - ${epoch.time}`;

    // 2. Actualizar el visor de Stellarium Web con la fecha y hora correspondientes
    updateStellariumView();

    // 3. Consultar el backend con los datos actualizados de esta época
    fetchBackendObservations(state.currentRA, state.currentDec, state.currentRadius);
}

function updateStellariumView() {
    const iframe = document.getElementById('stellarium-frame');
    const epoch = state.epochs[state.currentEpochIndex];
    
    // Stellarium Web acepta parámetros de latitud, longitud/ascesión recta, fov y fecha ISO
    const lng = -state.currentRA; // Conversión aproximada para visualización web
    const lat = state.currentDec;
    const fov = state.currentRadius;
    const dateStr = epoch.dateStr;

    iframe.src = `https://stellarium-web.org/?lat=${lat}&lng=${lng}&fov=${fov}&date=${dateStr}`;
    
    document.getElementById('hud-coords').innerText = `RA: ${state.currentRA.toFixed(4)} | Dec: ${state.currentDec > 0 ? '+' : ''}${state.currentDec.toFixed(4)}`;
}

// Conexión con FastAPI Backend (`http://127.0.0.1:8000/api/observations`)
async function fetchBackendObservations(ra, dec, radius) {
    const currentEpoch = state.epochs[state.currentEpochIndex];
    try {
        const response = await fetch(`http://127.0.0.1:8000/api/observations?ra=${ra}&dec=${dec}&radius=${radius}&epoch=${encodeURIComponent(currentEpoch.label)}`);
        if (!response.ok) throw new Error("Error en el servidor FastAPI");
        
        const data = await response.json();
        const count = Array.isArray(data) ? data.length : (data.sources ? data.sources.length : 1);
        
        document.getElementById('info-count').innerText = `${count} fuente(s) detectada(s)`;
        document.getElementById('info-status').innerText = "Conectado (OK)";
    } catch (err) {
        console.warn("Backend FastAPI offline:", err);
        document.getElementById('info-status').innerText = "Offline (Mock Mode)";
        document.getElementById('info-count').innerText = `3 fuentes (${currentEpoch.label})`;
    }
}

async function fetchBackendObservationsForModal(ra, dec, radius) {
    const container = document.getElementById('objects-list-container');
    const currentEpoch = state.epochs[state.currentEpochIndex];
    container.innerHTML = `<div style="color: var(--ylma-gold); text-align:center; padding: 20px;">Consultando backend para la época ${currentEpoch.label}...</div>`;

    try {
        const response = await fetch(`http://127.0.0.1:8000/api/observations?ra=${ra}&dec=${dec}&radius=${radius}&epoch=${encodeURIComponent(currentEpoch.label)}`);
        const data = await response.json();
        
        container.innerHTML = '';
        const items = Array.isArray(data) ? data : (data.sources || [data]);

        if (items.length === 0) {
            container.innerHTML = `<p style="color: #BDBDBD;">No se encontraron objetos en esta época.</p>`;
            return;
        }

        items.forEach((item, index) => {
            const card = document.createElement('div');
            card.style.cssText = "background: #111; border: 1px solid rgba(255,183,0,0.3); padding: 12px; border-radius: 6px; display: flex; flex-direction: column; gap: 4px;";
            card.innerHTML = `
                <div style="display: flex; justify-content: space-between; font-weight: 700; color: var(--ylma-gold);">
                    <span>#${index + 1} - ${item.name || item.id || 'Objeto Stellarium / SPHEREx'}</span>
                    <span style="font-size: 0.75rem; color: #888;">Época: ${currentEpoch.label} ${currentEpoch.time}</span>
                </div>
                <div style="font-size: 0.8rem; color: #ccc;">Coordenadas: RA ${ra} | Dec ${dec}</div>
                <div style="font-size: 0.75rem; color: #888;">Clasificación: ${item.classification || 'Fuente Astronómica Verificada'}</div>
            `;
            container.appendChild(card);
        });
    } catch (err) {
        container.innerHTML = `
            <div style="background: #111; border: 1px solid #FFB700; padding: 12px; border-radius: 6px;">
                <div style="color: var(--ylma-gold); font-weight: 600;">Objetos en Época: ${currentEpoch.label} (${currentEpoch.time})</div>
                <div style="font-size: 0.8rem; color: #ccc; margin-top: 4px;">RA: ${ra} | Dec: ${dec} | FOV: ${radius}°</div>
                <div style="font-size: 0.75rem; color: #888; margin-top: 2px;">(Datos simulados por respuesta offline del servidor local).</div>
            </div>
        `;
    }
}