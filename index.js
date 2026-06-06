require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const pdfParse = require('pdf-parse');
const db = require('./database');
const { uploadFile } = require('./r2');
const { extractVehicleData, extractGncData, extractInsuranceData } = require('./ai');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── VEHICLES ───────────────────────────────────────────────────────────────

app.get('/api/vehicles', (req, res) => {
  const rows = db.prepare(`
    SELECT v.*,
      (SELECT COUNT(*) FROM gnc_records WHERE vehicle_id = v.id) as gnc_count,
      (SELECT COUNT(*) FROM insurance_records WHERE vehicle_id = v.id) as insurance_count
    FROM vehicles v ORDER BY v.created_at DESC
  `).all();
  res.json(rows);
});

app.get('/api/vehicles/:id', (req, res) => {
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(req.params.id);
  if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado' });
  vehicle.contacts = db.prepare('SELECT * FROM vehicle_contacts WHERE vehicle_id = ?').all(req.params.id);
  res.json(vehicle);
});

app.post('/api/vehicles', upload.fields([
  { name: 'cedula_frente', maxCount: 1 },
  { name: 'cedula_dorso', maxCount: 1 },
  { name: 'foto_frente', maxCount: 1 },
  { name: 'foto_lateral_der', maxCount: 1 },
  { name: 'foto_lateral_izq', maxCount: 1 },
  { name: 'foto_detras', maxCount: 1 },
]), async (req, res) => {
  try {
    const data = req.body;
    const files = req.files || {};

    const uploadUrl = async (fieldName, folder) => {
      if (files[fieldName]?.[0]) {
        const f = files[fieldName][0];
        return uploadFile(f.buffer, f.originalname, folder);
      }
      return data[`${fieldName}_url`] || null;
    };

    const [cedula_frente_url, cedula_dorso_url, foto_frente_url, foto_lateral_der_url, foto_lateral_izq_url, foto_detras_url] =
      await Promise.all([
        uploadUrl('cedula_frente', 'cedulas'),
        uploadUrl('cedula_dorso', 'cedulas'),
        uploadUrl('foto_frente', 'fotos'),
        uploadUrl('foto_lateral_der', 'fotos'),
        uploadUrl('foto_lateral_izq', 'fotos'),
        uploadUrl('foto_detras', 'fotos'),
      ]);

    const contacts = data.contacts ? JSON.parse(data.contacts) : [];

    if (data.id) {
      db.prepare(`UPDATE vehicles SET
        patente=?, titular_nombre=?, titular_domicilio=?, chasis=?, motor=?,
        marca=?, modelo=?, anio=?, color=?, email=?, celular=?,
        cedula_frente_url=COALESCE(?, cedula_frente_url),
        cedula_dorso_url=COALESCE(?, cedula_dorso_url),
        foto_frente_url=COALESCE(?, foto_frente_url),
        foto_lateral_der_url=COALESCE(?, foto_lateral_der_url),
        foto_lateral_izq_url=COALESCE(?, foto_lateral_izq_url),
        foto_detras_url=COALESCE(?, foto_detras_url),
        updated_at=CURRENT_TIMESTAMP
        WHERE id=?`).run(
        data.patente, data.titular_nombre, data.titular_domicilio, data.chasis, data.motor,
        data.marca, data.modelo, data.anio || null, data.color, data.email, data.celular,
        cedula_frente_url, cedula_dorso_url, foto_frente_url,
        foto_lateral_der_url, foto_lateral_izq_url, foto_detras_url, data.id
      );
      db.prepare('DELETE FROM vehicle_contacts WHERE vehicle_id = ?').run(data.id);
      contacts.forEach(c => {
        db.prepare('INSERT INTO vehicle_contacts (vehicle_id, nombre, celular, email) VALUES (?,?,?,?)').run(data.id, c.nombre, c.celular, c.email);
      });
      return res.json({ id: data.id });
    }

    const result = db.prepare(`INSERT INTO vehicles
      (patente, titular_nombre, titular_domicilio, chasis, motor, marca, modelo, anio, color, email, celular,
       cedula_frente_url, cedula_dorso_url, foto_frente_url, foto_lateral_der_url, foto_lateral_izq_url, foto_detras_url)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      data.patente, data.titular_nombre, data.titular_domicilio, data.chasis, data.motor,
      data.marca, data.modelo, data.anio || null, data.color, data.email, data.celular,
      cedula_frente_url, cedula_dorso_url, foto_frente_url,
      foto_lateral_der_url, foto_lateral_izq_url, foto_detras_url
    );
    const vehicleId = result.lastInsertRowid;
    contacts.forEach(c => {
      db.prepare('INSERT INTO vehicle_contacts (vehicle_id, nombre, celular, email) VALUES (?,?,?,?)').run(vehicleId, c.nombre, c.celular, c.email);
    });
    res.json({ id: vehicleId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// AI: extract vehicle data from cedula images
app.post('/api/ai/extract-vehicle', upload.fields([
  { name: 'cedula_frente', maxCount: 1 },
  { name: 'cedula_dorso', maxCount: 1 },
]), async (req, res) => {
  try {
    const files = req.files || {};
    if (!files.cedula_frente?.[0]) return res.status(400).json({ error: 'Se requiere imagen del frente de la cédula' });
    const frente = files.cedula_frente[0];
    const dorso = files.cedula_dorso?.[0] || null;
    const data = await extractVehicleData(
      frente.buffer, dorso?.buffer || null,
      frente.mimetype, dorso?.mimetype || frente.mimetype
    );
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GNC ────────────────────────────────────────────────────────────────────

app.get('/api/vehicles/:id/gnc', (req, res) => {
  const rows = db.prepare('SELECT * FROM gnc_records WHERE vehicle_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json(rows);
});

app.post('/api/vehicles/:id/gnc', upload.single('archivo'), async (req, res) => {
  try {
    const vehicleId = req.params.id;
    const data = req.body;
    let archivo_url = null;

    if (req.file) {
      archivo_url = await uploadFile(req.file.buffer, req.file.originalname, 'gnc');
    }

    const result = db.prepare(`INSERT INTO gnc_records
      (vehicle_id, numero_oblea, regulador, fecha_vencimiento, archivo_url)
      VALUES (?,?,?,?,?)`).run(vehicleId, data.numero_oblea, data.regulador, data.fecha_vencimiento, archivo_url);

    generateGncAlert(vehicleId, result.lastInsertRowid, data.fecha_vencimiento);
    res.json({ id: result.lastInsertRowid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/extract-gnc', upload.single('archivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Se requiere imagen de la oblea GNC' });
    const data = await extractGncData(req.file.buffer, req.file.mimetype);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

function generateGncAlert(vehicleId, gncId, fechaVencimiento) {
  if (!fechaVencimiento) return;
  const venc = new Date(fechaVencimiento);
  const hoy = new Date();
  const diasRestantes = Math.ceil((venc - hoy) / (1000 * 60 * 60 * 24));
  if (diasRestantes <= 60) {
    const vehiculo = db.prepare('SELECT patente FROM vehicles WHERE id = ?').get(vehicleId);
    const patente = vehiculo?.patente || `ID ${vehicleId}`;
    db.prepare(`INSERT INTO alerts (vehicle_id, tipo, referencia_id, mensaje, fecha_vencimiento)
      VALUES (?,?,?,?,?)`).run(
      vehicleId, 'gnc', gncId,
      `GNC vence en ${diasRestantes} días para vehículo ${patente}`,
      fechaVencimiento
    );
  }
}

// ─── SEGUROS ─────────────────────────────────────────────────────────────────

app.get('/api/insurance-companies', (req, res) => {
  res.json(db.prepare('SELECT * FROM insurance_companies ORDER BY nombre').all());
});

app.get('/api/vehicles/:id/insurance', (req, res) => {
  const rows = db.prepare(`
    SELECT ir.*, ic.nombre as compania_nombre
    FROM insurance_records ir
    JOIN insurance_companies ic ON ir.company_id = ic.id
    WHERE ir.vehicle_id = ?
    ORDER BY ir.created_at DESC
  `).all(req.params.id);
  res.json(rows);
});

app.post('/api/vehicles/:id/insurance', upload.single('archivo'), async (req, res) => {
  try {
    const vehicleId = req.params.id;
    const data = req.body;
    let archivo_url = null;

    if (req.file) {
      archivo_url = await uploadFile(req.file.buffer, req.file.originalname, 'seguros');
    }

    let companyId = data.company_id ? parseInt(data.company_id) : null;
    if (!companyId && data.compania_nombre) {
      const existing = db.prepare('SELECT id FROM insurance_companies WHERE nombre = ?').get(data.compania_nombre);
      if (existing) {
        companyId = existing.id;
      } else {
        const ins = db.prepare('INSERT INTO insurance_companies (nombre) VALUES (?)').run(data.compania_nombre);
        companyId = ins.lastInsertRowid;
      }
    }

    if (!companyId) return res.status(400).json({ error: 'Se requiere compañía de seguros' });

    const result = db.prepare(`INSERT INTO insurance_records
      (vehicle_id, company_id, numero_poliza, vigencia_desde, vigencia_hasta, archivo_url)
      VALUES (?,?,?,?,?,?)`).run(vehicleId, companyId, data.numero_poliza, data.vigencia_desde, data.vigencia_hasta, archivo_url);

    generateInsuranceAlert(vehicleId, result.lastInsertRowid, data.vigencia_hasta);
    res.json({ id: result.lastInsertRowid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/extract-insurance', upload.single('archivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Se requiere documento de la póliza' });
    let data;
    if (req.file.mimetype === 'application/pdf') {
      const parsed = await pdfParse(req.file.buffer);
      data = await extractInsuranceData(parsed.text, false, null);
    } else {
      data = await extractInsuranceData(req.file.buffer.toString('base64'), true, req.file.mimetype);
    }
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

function generateInsuranceAlert(vehicleId, insuranceId, vigenciaHasta) {
  if (!vigenciaHasta) return;
  const venc = new Date(vigenciaHasta);
  const hoy = new Date();
  const diasRestantes = Math.ceil((venc - hoy) / (1000 * 60 * 60 * 24));
  if (diasRestantes <= 30) {
    const vehiculo = db.prepare('SELECT patente FROM vehicles WHERE id = ?').get(vehicleId);
    const patente = vehiculo?.patente || `ID ${vehicleId}`;
    db.prepare(`INSERT INTO alerts (vehicle_id, tipo, referencia_id, mensaje, fecha_vencimiento)
      VALUES (?,?,?,?,?)`).run(
      vehicleId, 'insurance', insuranceId,
      `Seguro vence en ${diasRestantes} días para vehículo ${patente}`,
      vigenciaHasta
    );
  }
}

// ─── ALERTAS ─────────────────────────────────────────────────────────────────

app.get('/api/alerts', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, v.patente, v.marca, v.modelo
    FROM alerts a
    JOIN vehicles v ON a.vehicle_id = v.id
    WHERE a.leida = 0
    ORDER BY a.fecha_vencimiento ASC
  `).all();
  res.json(rows);
});

app.patch('/api/alerts/:id/read', (req, res) => {
  db.prepare('UPDATE alerts SET leida = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Flota running on http://localhost:${PORT}`));
