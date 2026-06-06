// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {
  vehicles: [],
  companies: [],
  gncFiles: {},
  vehicleFiles: {},
  insuranceFile: null,
  editingVehicleId: null,
};

// ─── UTILS ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const val = id => $(id)?.value?.trim() ?? '';
const set = (id, v) => { if ($(id)) $(id).value = v ?? ''; };

function toast(msg, type = 'success') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3500);
}

function statusMsg(id, msg, type) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.className = `status-msg ${type}`;
  el.classList.remove('hidden');
}

function clearStatus(id) {
  const el = $(id);
  if (el) el.classList.add('hidden');
}

async function api(method, url, body) {
  const opts = { method };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ─── TABS ─────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(s => { s.classList.remove('active'); s.classList.add('hidden'); });
    btn.classList.add('active');
    const tab = $(`tab-${btn.dataset.tab}`);
    tab.classList.remove('hidden');
    tab.classList.add('active');
    if (btn.dataset.tab === 'gnc') loadGncTab();
    if (btn.dataset.tab === 'insurance') loadInsuranceTab();
    if (btn.dataset.tab === 'alerts') loadAlerts();
  });
});

// ─── MODALS ───────────────────────────────────────────────────────────────────
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

document.querySelectorAll('.modal-close, .modal-overlay').forEach(el => {
  el.addEventListener('click', () => {
    el.closest('.modal')?.classList.add('hidden');
  });
});

// ─── DROP ZONES ──────────────────────────────────────────────────────────────
function initDropZone(zoneEl, onFile) {
  const input = zoneEl.querySelector('input[type=file]');
  const preview = zoneEl.querySelector('.drop-preview');
  const filename = zoneEl.querySelector('.drop-filename');

  zoneEl.addEventListener('click', () => input.click());
  zoneEl.addEventListener('dragover', e => { e.preventDefault(); zoneEl.classList.add('drag-over'); });
  zoneEl.addEventListener('dragleave', () => zoneEl.classList.remove('drag-over'));
  zoneEl.addEventListener('drop', e => {
    e.preventDefault();
    zoneEl.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleDropFile(file, zoneEl, preview, filename, onFile);
  });
  input.addEventListener('change', () => {
    if (input.files[0]) handleDropFile(input.files[0], zoneEl, preview, filename, onFile);
  });
}

function handleDropFile(file, zoneEl, preview, filenameEl, onFile) {
  zoneEl.classList.add('has-file');
  if (file.type.startsWith('image/') && preview) {
    const reader = new FileReader();
    reader.onload = e => { preview.src = e.target.result; preview.classList.remove('hidden'); };
    reader.readAsDataURL(file);
    if (filenameEl) filenameEl.classList.add('hidden');
  } else if (filenameEl) {
    filenameEl.textContent = `📎 ${file.name}`;
    filenameEl.classList.remove('hidden');
    if (preview) preview.classList.add('hidden');
  }
  onFile(file);
}

// ─── SEARCHABLE SELECT ───────────────────────────────────────────────────────
function createSearchableSelect(containerEl, items, labelKey, valueKey, onSelect, allowNew = false) {
  const input = containerEl.querySelector('.ss-input');
  const dropdown = containerEl.querySelector('.ss-dropdown');
  const hiddenInput = containerEl.querySelector('input[type=hidden]');

  function render(filter = '') {
    const q = filter.toLowerCase();
    const matches = items.filter(i => i[labelKey].toLowerCase().includes(q));
    dropdown.innerHTML = '';
    if (matches.length === 0) {
      if (allowNew && filter) {
        const opt = document.createElement('div');
        opt.className = 'ss-option';
        opt.textContent = `+ Crear "${filter}"`;
        opt.addEventListener('click', () => {
          onSelect({ [valueKey]: null, [labelKey]: filter, isNew: true });
          input.value = filter;
          hiddenInput.value = '';
          dropdown.classList.add('hidden');
        });
        dropdown.appendChild(opt);
      } else {
        const opt = document.createElement('div');
        opt.className = 'ss-option no-match';
        opt.textContent = 'Sin resultados';
        dropdown.appendChild(opt);
      }
    } else {
      matches.forEach(item => {
        const opt = document.createElement('div');
        opt.className = 'ss-option';
        opt.textContent = item[labelKey];
        opt.addEventListener('click', () => {
          onSelect(item);
          input.value = item[labelKey];
          hiddenInput.value = item[valueKey];
          dropdown.classList.add('hidden');
        });
        dropdown.appendChild(opt);
      });
    }
  }

  input.addEventListener('focus', () => { render(input.value); dropdown.classList.remove('hidden'); });
  input.addEventListener('input', () => { render(input.value); dropdown.classList.remove('hidden'); });
  document.addEventListener('click', e => {
    if (!containerEl.contains(e.target)) dropdown.classList.add('hidden');
  });

  return { refresh(newItems) { items = newItems; }, setValue(label, value) { input.value = label; hiddenInput.value = value; } };
}

// ─── VEHICLES ────────────────────────────────────────────────────────────────
async function loadVehicles() {
  state.vehicles = await api('GET', '/api/vehicles');
  renderVehicleList();
}

function renderVehicleList() {
  const el = $('vehicles-list');
  if (!state.vehicles.length) {
    el.innerHTML = '<div class="empty-state">No hay vehículos registrados. Hacé click en "+ Nuevo Vehículo" para empezar.</div>';
    return;
  }
  el.innerHTML = state.vehicles.map(v => `
    <div class="card">
      <div class="card-title">${v.patente || 'Sin patente'}</div>
      <div class="card-sub">${[v.marca, v.modelo, v.anio].filter(Boolean).join(' · ')}</div>
      <div class="card-meta">
        ${v.titular_nombre ? `<span class="tag">👤 ${v.titular_nombre}</span>` : ''}
        ${v.gnc_count > 0 ? `<span class="tag">GNC ×${v.gnc_count}</span>` : ''}
        ${v.insurance_count > 0 ? `<span class="tag">Seguros ×${v.insurance_count}</span>` : ''}
      </div>
      <div class="card-actions">
        <button class="btn btn-secondary btn-sm" onclick="editVehicle(${v.id})">✏️ Editar</button>
      </div>
    </div>
  `).join('');
}

$('btn-new-vehicle').addEventListener('click', () => {
  resetVehicleForm();
  openModal('modal-vehicle');
});

function resetVehicleForm() {
  state.editingVehicleId = null;
  state.vehicleFiles = {};
  $('modal-vehicle-title').textContent = 'Registrar Vehículo';
  ['v-patente','v-marca','v-modelo','v-anio','v-color','v-chasis','v-motor',
   'v-titular-nombre','v-titular-domicilio','v-email','v-celular'].forEach(id => set(id, ''));
  $('contacts-list').innerHTML = '';
  document.querySelectorAll('#modal-vehicle .drop-zone').forEach(z => {
    z.classList.remove('has-file');
    const prev = z.querySelector('.drop-preview');
    if (prev) { prev.src = ''; prev.classList.add('hidden'); }
    const inp = z.querySelector('input[type=file]');
    if (inp) inp.value = '';
  });
  clearStatus('extract-vehicle-status');
}

async function editVehicle(id) {
  const v = await api('GET', `/api/vehicles/${id}`);
  resetVehicleForm();
  state.editingVehicleId = id;
  $('modal-vehicle-title').textContent = 'Editar Vehículo';
  set('v-patente', v.patente); set('v-marca', v.marca); set('v-modelo', v.modelo);
  set('v-anio', v.anio); set('v-color', v.color); set('v-chasis', v.chasis);
  set('v-motor', v.motor); set('v-titular-nombre', v.titular_nombre);
  set('v-titular-domicilio', v.titular_domicilio); set('v-email', v.email);
  set('v-celular', v.celular);
  (v.contacts || []).forEach(c => addContactRow(c));
  openModal('modal-vehicle');
}

// Drop zones for vehicle form
const vehicleDropZones = ['cedula_frente','cedula_dorso','foto_frente','foto_lateral_der','foto_lateral_izq','foto_detras'];
vehicleDropZones.forEach(field => {
  const zoneId = `drop-${field.replace(/_/g,'-')}`;
  const el = $(zoneId);
  if (el) initDropZone(el, file => { state.vehicleFiles[field] = file; });
});

// AI extraction for vehicle
$('btn-extract-vehicle').addEventListener('click', async () => {
  if (!state.vehicleFiles.cedula_frente) {
    return toast('Primero cargá al menos el frente de la cédula', 'error');
  }
  statusMsg('extract-vehicle-status', '⏳ Analizando cédula con IA...', 'loading');
  try {
    const fd = new FormData();
    fd.append('cedula_frente', state.vehicleFiles.cedula_frente);
    if (state.vehicleFiles.cedula_dorso) fd.append('cedula_dorso', state.vehicleFiles.cedula_dorso);
    const data = await api('POST', '/api/ai/extract-vehicle', fd);
    set('v-patente', data.patente); set('v-marca', data.marca); set('v-modelo', data.modelo);
    set('v-anio', data.anio); set('v-color', data.color); set('v-chasis', data.chasis);
    set('v-motor', data.motor); set('v-titular-nombre', data.titular_nombre);
    set('v-titular-domicilio', data.titular_domicilio);
    statusMsg('extract-vehicle-status', '✅ Datos extraídos. Revisá y completá los faltantes.', 'success');
  } catch (e) {
    statusMsg('extract-vehicle-status', `❌ Error: ${e.message}`, 'error');
  }
});

// Contacts
$('btn-add-contact').addEventListener('click', () => addContactRow());
function addContactRow(c = {}) {
  const row = document.createElement('div');
  row.className = 'contact-row';
  row.innerHTML = `
    <input type="text" placeholder="Nombre" value="${c.nombre||''}" data-key="nombre" />
    <input type="tel" placeholder="Celular" value="${c.celular||''}" data-key="celular" />
    <input type="email" placeholder="Email" value="${c.email||''}" data-key="email" />
    <button class="btn btn-danger btn-sm" onclick="this.closest('.contact-row').remove()">✕</button>
  `;
  $('contacts-list').appendChild(row);
}

$('btn-save-vehicle').addEventListener('click', async () => {
  const patente = val('v-patente');
  if (!patente) return toast('La patente es obligatoria', 'error');
  if (!val('v-email')) return toast('El email es obligatorio', 'error');
  if (!val('v-celular')) return toast('El celular es obligatorio', 'error');

  const contacts = [...document.querySelectorAll('#contacts-list .contact-row')].map(row => ({
    nombre: row.querySelector('[data-key=nombre]').value,
    celular: row.querySelector('[data-key=celular]').value,
    email: row.querySelector('[data-key=email]').value,
  }));

  const fd = new FormData();
  if (state.editingVehicleId) fd.append('id', state.editingVehicleId);
  fd.append('patente', patente);
  fd.append('marca', val('v-marca')); fd.append('modelo', val('v-modelo'));
  fd.append('anio', val('v-anio')); fd.append('color', val('v-color'));
  fd.append('chasis', val('v-chasis')); fd.append('motor', val('v-motor'));
  fd.append('titular_nombre', val('v-titular-nombre'));
  fd.append('titular_domicilio', val('v-titular-domicilio'));
  fd.append('email', val('v-email')); fd.append('celular', val('v-celular'));
  fd.append('contacts', JSON.stringify(contacts));

  vehicleDropZones.forEach(field => {
    if (state.vehicleFiles[field]) fd.append(field, state.vehicleFiles[field]);
  });

  try {
    await api('POST', '/api/vehicles', fd);
    toast(state.editingVehicleId ? 'Vehículo actualizado' : 'Vehículo registrado');
    closeModal('modal-vehicle');
    loadVehicles();
  } catch (e) {
    toast(e.message, 'error');
  }
});

// ─── GNC ─────────────────────────────────────────────────────────────────────
let gncVehicleSelect = null;

async function loadGncTab() {
  const records = await api('GET', '/api/vehicles').then(vs =>
    Promise.all(vs.map(v => api('GET', `/api/vehicles/${v.id}/gnc`).then(rs => rs.map(r => ({ ...r, vehicle: v })))))
  ).then(all => all.flat());
  renderGncList(records);
}

function renderGncList(records) {
  const el = $('gnc-list');
  if (!records.length) {
    el.innerHTML = '<div class="empty-state">No hay registros de GNC.</div>';
    return;
  }
  el.innerHTML = records.map(r => {
    const venc = r.fecha_vencimiento ? new Date(r.fecha_vencimiento) : null;
    const dias = venc ? Math.ceil((venc - new Date()) / 86400000) : null;
    const tagClass = dias === null ? '' : dias <= 14 ? 'tag-danger' : dias <= 60 ? 'tag-warn' : '';
    return `
      <div class="card">
        <div class="card-title">${r.vehicle?.patente || ''}</div>
        <div class="card-sub">${r.vehicle?.marca || ''} ${r.vehicle?.modelo || ''}</div>
        <div class="card-meta">
          ${r.numero_oblea ? `<span class="tag">Oblea: ${r.numero_oblea}</span>` : ''}
          ${r.regulador ? `<span class="tag">Reg: ${r.regulador}</span>` : ''}
          ${venc ? `<span class="tag ${tagClass}">Vence: ${r.fecha_vencimiento} ${dias !== null ? `(${dias}d)` : ''}</span>` : ''}
        </div>
        ${r.archivo_url ? `<a href="${r.archivo_url}" target="_blank" class="btn btn-secondary btn-sm">📎 Ver archivo</a>` : ''}
      </div>
    `;
  }).join('');
}

$('btn-new-gnc').addEventListener('click', () => {
  resetGncForm();
  openModal('modal-gnc');
  initGncVehicleSelect();
});

function resetGncForm() {
  state.gncFiles = {};
  set('gnc-numero-oblea',''); set('gnc-regulador',''); set('gnc-fecha-vencimiento','');
  set('gnc-vehicle-id','');
  const z = $('drop-gnc');
  if (z) { z.classList.remove('has-file'); const p = z.querySelector('.drop-preview'); if(p){p.src='';p.classList.add('hidden');} const i=z.querySelector('input');if(i)i.value=''; }
  clearStatus('extract-gnc-status');
}

function initGncVehicleSelect() {
  const container = document.querySelector('#modal-gnc .searchable-select');
  if (!container) return;
  container.querySelector('.ss-input').value = '';
  container.querySelector('.ss-dropdown').innerHTML = '';
  gncVehicleSelect = createSearchableSelect(
    container,
    state.vehicles,
    v => `${v.patente} — ${v.titular_nombre || ''}`,
    'id',
    v => set('gnc-vehicle-id', v.id)
  );
}

initDropZone($('drop-gnc'), file => { state.gncFiles.archivo = file; });

$('btn-extract-gnc').addEventListener('click', async () => {
  if (!state.gncFiles.archivo) return toast('Primero cargá la imagen de la oblea', 'error');
  statusMsg('extract-gnc-status', '⏳ Analizando oblea con IA...', 'loading');
  try {
    const fd = new FormData();
    fd.append('archivo', state.gncFiles.archivo);
    const data = await api('POST', '/api/ai/extract-gnc', fd);
    set('gnc-numero-oblea', data.numero_oblea);
    set('gnc-regulador', data.regulador);
    set('gnc-fecha-vencimiento', data.fecha_vencimiento);
    statusMsg('extract-gnc-status', '✅ Datos extraídos con IA.', 'success');
  } catch(e) {
    statusMsg('extract-gnc-status', `❌ Error: ${e.message}`, 'error');
  }
});

$('btn-save-gnc').addEventListener('click', async () => {
  const vehicleId = val('gnc-vehicle-id');
  if (!vehicleId) return toast('Seleccioná un vehículo', 'error');
  if (!val('gnc-fecha-vencimiento')) return toast('La fecha de vencimiento es obligatoria', 'error');

  const fd = new FormData();
  fd.append('numero_oblea', val('gnc-numero-oblea'));
  fd.append('regulador', val('gnc-regulador'));
  fd.append('fecha_vencimiento', val('gnc-fecha-vencimiento'));
  if (state.gncFiles.archivo) fd.append('archivo', state.gncFiles.archivo);

  try {
    await api('POST', `/api/vehicles/${vehicleId}/gnc`, fd);
    toast('Registro GNC guardado');
    closeModal('modal-gnc');
    loadGncTab();
  } catch(e) {
    toast(e.message, 'error');
  }
});

// ─── INSURANCE ───────────────────────────────────────────────────────────────
let insVehicleSelect = null;
let insCompanySelect = null;
let insNewCompanyName = null;

async function loadInsuranceTab() {
  state.companies = await api('GET', '/api/insurance-companies');
  const records = await api('GET', '/api/vehicles').then(vs =>
    Promise.all(vs.map(v => api('GET', `/api/vehicles/${v.id}/insurance`).then(rs => rs.map(r => ({ ...r, vehicle: v })))))
  ).then(all => all.flat());
  renderInsuranceList(records);
}

function renderInsuranceList(records) {
  const el = $('insurance-list');
  if (!records.length) {
    el.innerHTML = '<div class="empty-state">No hay pólizas registradas.</div>';
    return;
  }
  el.innerHTML = records.map(r => {
    const venc = r.vigencia_hasta ? new Date(r.vigencia_hasta) : null;
    const dias = venc ? Math.ceil((venc - new Date()) / 86400000) : null;
    const tagClass = dias === null ? '' : dias <= 7 ? 'tag-danger' : dias <= 30 ? 'tag-warn' : '';
    return `
      <div class="card">
        <div class="card-title">${r.vehicle?.patente || ''}</div>
        <div class="card-sub">${r.compania_nombre || ''}</div>
        <div class="card-meta">
          ${r.numero_poliza ? `<span class="tag">Póliza: ${r.numero_poliza}</span>` : ''}
          ${r.vigencia_desde ? `<span class="tag">Desde: ${r.vigencia_desde}</span>` : ''}
          ${venc ? `<span class="tag ${tagClass}">Hasta: ${r.vigencia_hasta} ${dias !== null ? `(${dias}d)` : ''}</span>` : ''}
        </div>
        ${r.archivo_url ? `<a href="${r.archivo_url}" target="_blank" class="btn btn-secondary btn-sm">📎 Ver archivo</a>` : ''}
      </div>
    `;
  }).join('');
}

$('btn-new-insurance').addEventListener('click', async () => {
  if (!state.companies.length) state.companies = await api('GET', '/api/insurance-companies');
  resetInsuranceForm();
  openModal('modal-insurance');
  initInsVehicleSelect();
  initInsCompanySelect();
});

function resetInsuranceForm() {
  state.insuranceFile = null;
  insNewCompanyName = null;
  set('ins-vehicle-id',''); set('ins-company-id',''); set('ins-company-input','');
  set('ins-numero-poliza',''); set('ins-vigencia-desde',''); set('ins-vigencia-hasta','');
  const z = $('drop-insurance');
  if (z) {
    z.classList.remove('has-file');
    const p = z.querySelector('.drop-preview'); if(p){p.src='';p.classList.add('hidden');}
    const fn = z.querySelector('.drop-filename'); if(fn) fn.classList.add('hidden');
    const i = z.querySelector('input'); if(i) i.value='';
  }
  clearStatus('extract-insurance-status');
}

function initInsVehicleSelect() {
  const container = document.querySelector('#modal-insurance #ins-vehicle-select');
  if (!container) return;
  container.querySelector('.ss-input').value = '';
  insVehicleSelect = createSearchableSelect(
    container,
    state.vehicles,
    v => `${v.patente} — ${v.titular_nombre || ''}`,
    'id',
    v => set('ins-vehicle-id', v.id)
  );
}

function initInsCompanySelect() {
  const container = document.querySelector('#modal-insurance #ins-company-select');
  if (!container) return;
  container.querySelector('.ss-input').value = '';
  insCompanySelect = createSearchableSelect(
    container,
    state.companies,
    'nombre',
    'id',
    c => {
      if (c.isNew) { insNewCompanyName = c.nombre; set('ins-company-id', ''); }
      else { insNewCompanyName = null; set('ins-company-id', c.id); }
    },
    true
  );
}

initDropZone($('drop-insurance'), file => { state.insuranceFile = file; });

$('btn-extract-insurance').addEventListener('click', async () => {
  if (!state.insuranceFile) return toast('Primero cargá el documento de la póliza', 'error');
  statusMsg('extract-insurance-status', '⏳ Analizando póliza con IA...', 'loading');
  try {
    const fd = new FormData();
    fd.append('archivo', state.insuranceFile);
    const data = await api('POST', '/api/ai/extract-insurance', fd);
    set('ins-numero-poliza', data.numero_poliza);
    set('ins-vigencia-desde', data.vigencia_desde);
    set('ins-vigencia-hasta', data.vigencia_hasta);
    if (data.compania && insCompanySelect) {
      const existing = state.companies.find(c => c.nombre.toLowerCase() === data.compania.toLowerCase());
      if (existing) {
        insCompanySelect.setValue(existing.nombre, existing.id);
        insNewCompanyName = null;
      } else {
        insCompanySelect.setValue(data.compania, '');
        insNewCompanyName = data.compania;
      }
    }
    statusMsg('extract-insurance-status', '✅ Datos extraídos con IA.', 'success');
  } catch(e) {
    statusMsg('extract-insurance-status', `❌ Error: ${e.message}`, 'error');
  }
});

$('btn-save-insurance').addEventListener('click', async () => {
  const vehicleId = val('ins-vehicle-id');
  if (!vehicleId) return toast('Seleccioná un vehículo', 'error');
  const companyId = val('ins-company-id');
  const companyName = insNewCompanyName || $('ins-company-input')?.value?.trim();
  if (!companyId && !companyName) return toast('Seleccioná o escribí una compañía de seguros', 'error');
  if (!val('ins-numero-poliza')) return toast('El número de póliza es obligatorio', 'error');

  const fd = new FormData();
  fd.append('numero_poliza', val('ins-numero-poliza'));
  fd.append('vigencia_desde', val('ins-vigencia-desde'));
  fd.append('vigencia_hasta', val('ins-vigencia-hasta'));
  if (companyId) fd.append('company_id', companyId);
  else fd.append('compania_nombre', companyName);
  if (state.insuranceFile) fd.append('archivo', state.insuranceFile);

  try {
    await api('POST', `/api/vehicles/${vehicleId}/insurance`, fd);
    // refresh companies list
    state.companies = await api('GET', '/api/insurance-companies');
    toast('Póliza guardada');
    closeModal('modal-insurance');
    loadInsuranceTab();
  } catch(e) {
    toast(e.message, 'error');
  }
});

// ─── ALERTS ───────────────────────────────────────────────────────────────────
async function loadAlerts() {
  const alerts = await api('GET', '/api/alerts');
  const badge = $('alert-badge');
  if (alerts.length > 0) { badge.textContent = alerts.length; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');

  const el = $('alerts-list');
  if (!alerts.length) {
    el.innerHTML = '<div class="empty-state" style="text-align:center;padding:3rem;color:#64748b">✅ No hay alertas pendientes.</div>';
    return;
  }
  el.innerHTML = alerts.map(a => {
    const dias = a.fecha_vencimiento ? Math.ceil((new Date(a.fecha_vencimiento) - new Date()) / 86400000) : null;
    const cls = dias !== null && dias <= 7 ? 'urgent' : 'warning';
    return `
      <div class="alert-item ${cls}">
        <div class="alert-info">
          <div class="alert-msg">${a.mensaje}</div>
          <div class="alert-date">${a.tipo === 'gnc' ? '⛽ GNC' : '🛡️ Seguro'} · Vence: ${a.fecha_vencimiento || '—'} ${dias !== null ? `(${dias} días)` : ''}</div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="markAlertRead(${a.id}, this)">✓ Marcar leída</button>
      </div>
    `;
  }).join('');
}

async function markAlertRead(id, btn) {
  await api('PATCH', `/api/alerts/${id}/read`);
  btn.closest('.alert-item').remove();
  loadAlerts();
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  await loadVehicles();
  loadAlerts();
}

init();
