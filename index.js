require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { initializeDatabase, getPool } = require('./database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ── Wrapper IA centralizado (logging de tokens, credencial activa) ───────────
const { callAI, invalidateIACredCache: _invalidateIACredCache } = require('./ia-helper');

// ── Cifrado de número de tarjeta ─────────────────────────────────────────────
const CARD_FALLBACK_SECRET = process.env.CARD_SECRET || 'flota-card-secret-2024';

function _cardKey(dni, apellido) {
  const base = ((dni || '') + (apellido || '')).trim() || CARD_FALLBACK_SECRET;
  return crypto.createHash('sha256').update(base).digest(); // 32 bytes
}

function encryptCardNro(nro, dni, apellido) {
  if (!nro) return null;
  const key = _cardKey(dni, apellido);
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc  = Buffer.concat([cipher.update(nro, 'utf8'), cipher.final()]);
  const tag  = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}

function decryptCardNro(stored, dni, apellido) {
  if (!stored) return null;
  try {
    const [ivHex, tagHex, encHex] = stored.split(':');
    const key    = _cardKey(dni, apellido);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(encHex, 'hex')) + decipher.final('utf8');
  } catch { return null; }
}

function maskCardNro(nro) {
  if (!nro) return null;
  const digits = nro.replace(/\D/g, '');
  if (digits.length < 10) return digits;
  return digits.slice(0, 6) + 'X'.repeat(digits.length - 10) + digits.slice(-4);
}

// ── Multer instances (declaradas temprano para uso en toda la app) ──
const _diskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: _diskStorage });
const memUpload = multer({ storage: multer.memoryStorage() });
const uploadServiceFoto = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, 'public', 'uploads', 'services', req.params.id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => { cb(null, `foto_${Date.now()}${path.extname(file.originalname)}`); }
  }),
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/'))
});

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'flotacontrol-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static('public'));

// --- AUTH MIDDLEWARE ---
const PUBLIC_PATHS = ['/auth/login', '/ai/status'];
function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.includes(req.path)) return next();
  if (req.session?.usuario) return next();
  res.status(401).json({ message: 'No autenticado' });
}
app.use('/api', requireAuth);

// Inyectar usuario en contexto de audit
function getUsuarioId(req) { return req.session?.usuario?.id || null; }

async function registrarAuditoria(req, modulo, accion, entidadId, descripcion) {
  try {
    const db = await getPool();
    const u = req.session?.usuario;
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || null;
    await db.query(
      'INSERT INTO auditoria (usuario_id, usuario_nombre, modulo, accion, entidad_id, descripcion, ip) VALUES (?,?,?,?,?,?,?)',
      [u?.id||null, u?.nombre||null, modulo, accion, entidadId||null, descripcion||null, ip]
    );
  } catch(_) {}
}

async function checkPuedeEliminar(req, res) {
  const u = req.session?.usuario;
  if (!u) { res.status(401).json({ message: 'No autenticado' }); return false; }
  if (u.rol === 'superadmin') return true;
  const db = await getPool();
  const [r] = await db.query(
    'SELECT puede_eliminar FROM permisos_pantallas WHERE usuario_id=? AND puede_eliminar=1 LIMIT 1', [u.id]
  );
  if (r.length) return true;
  res.status(403).json({ message: 'No tenés permiso para eliminar registros.' });
  return false;
}

// --- ENDPOINTS DE LA API ---

// 1. Estadísticas Globales del Dashboard
app.get('/api/dashboard-stats', async (req, res) => {
  try {
    const db = await getPool();
    const [ch] = await db.query('SELECT COUNT(*) as count FROM choferes WHERE activo = 1');
    const [vh] = await db.query('SELECT COUNT(*) as count FROM vehiculos WHERE activo = 1');
    const [ml] = await db.query('SELECT COUNT(*) as count FROM multas WHERE estado = "pendiente"');
    const [sv] = await db.query('SELECT COUNT(*) as count FROM services');
    
    res.json({
      choferes: ch[0]?.count || 0,
      vehiculos: vh[0]?.count || 0,
      multas: ml[0]?.count || 0,
      services: sv[0]?.count || 0
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── TURNOS ────────────────────────────────────────────────────────────────────
app.get('/api/turnos', async (req, res) => {
  try {
    const db = await getPool();
    const { desde, hasta, chofer_id, vehiculo_id } = req.query;
    const conds = [], params = [];
    if (desde)      { conds.push('t.fecha_inicio >= ?');  params.push(desde); }
    if (hasta)      { conds.push('t.fecha_inicio <= ?');  params.push(hasta + ' 23:59:59'); }
    if (chofer_id)  { conds.push('t.chofer_id = ?');      params.push(chofer_id); }
    if (vehiculo_id){ conds.push('t.vehiculo_id = ?');    params.push(vehiculo_id); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const [rows] = await db.query(`
      SELECT t.*,
        ch.nombre AS chofer_nombre,
        v.patente AS vehiculo_patente, v.marca AS vehiculo_marca, v.modelo AS vehiculo_modelo,
        CASE WHEN t.fecha_fin IS NOT NULL THEN COALESCE((
          SELECT SUM(p.importe) FROM peajes p
          WHERE p.vehiculo_id = t.vehiculo_id
            AND p.fecha_hora >= t.fecha_inicio
            AND p.fecha_hora <= t.fecha_fin
        ), 0) ELSE NULL END AS peajes_auto,
        CASE WHEN t.fecha_fin IS NOT NULL THEN COALESCE((
          SELECT SUM(m.monto) FROM multas m
          WHERE (m.chofer_id = t.chofer_id OR m.vehiculo_id = t.vehiculo_id)
            AND m.estado IN ('pendiente','apelada','pagada')
            AND DATE_ADD(m.fecha_infraccion, INTERVAL TIME_TO_SEC(IFNULL(m.hora_infraccion,'00:00:00')) SECOND) >= t.fecha_inicio
            AND DATE_ADD(m.fecha_infraccion, INTERVAL TIME_TO_SEC(IFNULL(m.hora_infraccion,'00:00:00')) SECOND) <= t.fecha_fin
        ), 0) ELSE NULL END AS multas_pendientes
      FROM turnos t
      JOIN choferes ch ON ch.id = t.chofer_id
      LEFT JOIN vehiculos v ON v.id = t.vehiculo_id
      ${where}
      ORDER BY t.fecha_inicio DESC
    `, params);
    res.json(rows);
  } catch(err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/turnos/ultimo-km/:vehiculo_id', requireAuth, async (req, res) => {
  try {
    const db = await getPool();
    const [[row]] = await db.query(
      `SELECT km_fin FROM turnos WHERE vehiculo_id=? AND km_fin IS NOT NULL ORDER BY fecha_inicio DESC LIMIT 1`,
      [req.params.vehiculo_id]
    );
    res.json({ km_fin: row?.km_fin ?? null });
  } catch(err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/turnos/:id', async (req, res) => {
  try {
    const db = await getPool();
    const [[row]] = await db.query(`
      SELECT t.*,
        ch.nombre AS chofer_nombre, ch.modalidad AS chofer_modalidad,
        v.patente AS vehiculo_patente
      FROM turnos t
      JOIN choferes ch ON ch.id = t.chofer_id
      LEFT JOIN vehiculos v ON v.id = t.vehiculo_id
      WHERE t.id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ message: 'No encontrado' });

    // Solo calcular detalle si tiene fecha_fin definida
    let peajes = [], multas = [];
    if (row.fecha_fin) {
      [peajes] = await db.query(`
        SELECT p.id, p.autopista, p.barrera, p.fecha_hora, p.importe, p.patente
        FROM peajes p
        WHERE p.vehiculo_id = ? AND p.fecha_hora >= ? AND p.fecha_hora <= ?
        ORDER BY p.fecha_hora ASC
      `, [row.vehiculo_id, row.fecha_inicio, row.fecha_fin]);

      [multas] = await db.query(`
        SELECT m.id, m.numero_acta, m.fecha_infraccion, m.hora_infraccion,
               m.descripcion, m.monto, m.estado, m.lugar, m.archivo_adjunto,
               (SELECT CONCAT('[', GROUP_CONCAT(
                  JSON_OBJECT('id',a.id,'tipo',a.tipo,'url',a.url,'nombre',a.nombre_original)
                  ORDER BY a.id SEPARATOR ','
               ), ']')
                FROM multa_adjuntos a WHERE a.multa_id = m.id) AS adjuntos_json
        FROM multas m
        WHERE (m.chofer_id = ? OR m.vehiculo_id = ?)
          AND m.estado IN ('pendiente','apelada','pagada')
          AND DATE_ADD(m.fecha_infraccion, INTERVAL TIME_TO_SEC(IFNULL(m.hora_infraccion,'00:00:00')) SECOND) >= ?
          AND DATE_ADD(m.fecha_infraccion, INTERVAL TIME_TO_SEC(IFNULL(m.hora_infraccion,'00:00:00')) SECOND) <= ?
        ORDER BY m.fecha_infraccion ASC
      `, [row.chofer_id, row.vehiculo_id, row.fecha_inicio, row.fecha_fin]);
    }

    res.json({ ...row, peajes_detalle: peajes, multas_detalle: multas });
  } catch(err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/turnos', memUpload.single('foto_novedad'), async (req, res) => {
  try {
    const db = await getPool();
    const uid = req.session?.userId || null;
    const { fecha_inicio, fecha_fin, horas, km_inicio, km_fin, recorrido,
            vehiculo_id, chofer_id, modalidad, gnc, viajes, peajes, importe, notas, aceite_ok,
            aceite_nivel, foto_km_inicio, foto_km_fin, combustible_inicio, combustible_fin } = req.body;
    if (!chofer_id || !fecha_inicio) return res.status(400).json({ message: 'Chofer y fecha inicio son obligatorios' });
    // Guardar foto novedad si viene
    let foto_novedad_url = null;
    let foto_aceite_url = req.body.foto_aceite || null;
    if (req.file) {
      const pathM = require('path'), fs = require('fs');
      const dir = pathM.join(__dirname, 'public', 'uploads', 'turnos');
      fs.mkdirSync(dir, { recursive: true });
      const fname = `novedad_${Date.now()}_${req.file.originalname}`;
      fs.writeFileSync(pathM.join(dir, fname), req.file.buffer);
      foto_novedad_url = `/uploads/turnos/${fname}`;
    }
    const _aceite = v => v!=null ? (v==='1'||v===true?1:0) : null;
    const [r] = await db.query(
      `INSERT INTO turnos (fecha_inicio,fecha_fin,horas,km_inicio,km_fin,recorrido,vehiculo_id,chofer_id,modalidad,gnc,viajes,peajes,importe,notas,aceite_ok,aceite_nivel,foto_aceite,foto_novedad,foto_km_inicio,foto_km_fin,combustible_inicio,combustible_fin,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [fecha_inicio, fecha_fin||null, horas||null, km_inicio||null, km_fin||null, recorrido||null,
       vehiculo_id||null, chofer_id, modalidad||null, gnc||0, viajes||0, peajes||0, importe||null, notas||null,
       _aceite(aceite_ok), aceite_nivel||null, foto_aceite_url||null, foto_novedad_url,
       foto_km_inicio||null, foto_km_fin||null, combustible_inicio||null, combustible_fin||null, uid]);
    const [[ch]] = await db.query('SELECT nombre FROM choferes WHERE id=?', [chofer_id]);
    const [[vh]] = await db.query('SELECT patente FROM vehiculos WHERE id=?', [vehiculo_id||0]);
    await registrarAuditoria(req, 'turnos', 'crear', r.insertId, `Turno #${r.insertId} — ${ch?.nombre||'?'} · ${vh?.patente||'?'} · ${fecha_inicio}`);
    res.json({ id: r.insertId });
  } catch(err) { res.status(500).json({ message: err.message }); }
});

app.put('/api/turnos/:id', memUpload.single('foto_novedad'), async (req, res) => {
  try {
    const db = await getPool();
    const uid = req.session?.userId || null;
    const { fecha_inicio, fecha_fin, horas, km_inicio, km_fin, recorrido,
            vehiculo_id, chofer_id, modalidad, gnc, viajes, peajes, importe, notas, aceite_ok,
            aceite_nivel, foto_km_inicio, foto_km_fin, combustible_inicio, combustible_fin } = req.body;
    // Foto novedad: si viene nueva, guardar; si no, conservar la existente
    let foto_novedad_url = req.body.foto_novedad_url || null;
    let foto_aceite_url2 = req.body.foto_aceite || null;
    if (req.file) {
      const pathM = require('path'), fs = require('fs');
      const dir = pathM.join(__dirname, 'public', 'uploads', 'turnos');
      fs.mkdirSync(dir, { recursive: true });
      const fname = `novedad_${Date.now()}_${req.file.originalname}`;
      fs.writeFileSync(pathM.join(dir, fname), req.file.buffer);
      foto_novedad_url = `/uploads/turnos/${fname}`;
    }
    const _aceite2 = v => v!=null ? (v==='1'||v===true?1:0) : null;
    await db.query(
      `UPDATE turnos SET fecha_inicio=?,fecha_fin=?,horas=?,km_inicio=?,km_fin=?,recorrido=?,
       vehiculo_id=?,chofer_id=?,modalidad=?,gnc=?,viajes=?,peajes=?,importe=?,notas=?,aceite_ok=?,aceite_nivel=?,foto_aceite=?,foto_novedad=?,
       foto_km_inicio=?,foto_km_fin=?,combustible_inicio=?,combustible_fin=?,updated_by=?
       WHERE id=?`,
      [fecha_inicio, fecha_fin||null, horas||null, km_inicio||null, km_fin||null, recorrido||null,
       vehiculo_id||null, chofer_id, modalidad||null, gnc||0, viajes||0, peajes||0, importe||null, notas||null,
       _aceite2(aceite_ok), aceite_nivel||null, foto_aceite_url2||null, foto_novedad_url,
       foto_km_inicio||null, foto_km_fin||null, combustible_inicio||null, combustible_fin||null,
       uid, req.params.id]);
    const [[ch2]] = await db.query('SELECT nombre FROM choferes WHERE id=?', [chofer_id]);
    const [[vh2]] = await db.query('SELECT patente FROM vehiculos WHERE id=?', [vehiculo_id||0]);
    await registrarAuditoria(req, 'turnos', 'editar', req.params.id, `Turno #${req.params.id} — ${ch2?.nombre||'?'} · ${vh2?.patente||'?'} · ${fecha_inicio}`);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/turnos/:id', async (req, res) => {
  try {
    const db = await getPool();
    await db.query('DELETE FROM turnos WHERE id=?', [req.params.id]);
    await registrarAuditoria(req, 'turnos', 'eliminar', req.params.id);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ message: err.message }); }
});

// 2. Choferes (GET, POST, PUT, DELETE)
app.get('/api/choferes', async (req, res) => {
  try {
    const db = await getPool();
    const { activo } = req.query;
    const where = activo !== undefined ? `WHERE c.activo = ${activo === '1' ? 1 : 0}` : '';
    const [rows] = await db.query(`
      SELECT c.*, cf.nombre as condicion_fiscal
      FROM choferes c
      LEFT JOIN condiciones_fiscales cf ON c.condicion_fiscal_id = cf.id
      ${where}
      ORDER BY c.nombre ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/choferes', async (req, res) => {
  const { nombre, telefono, dni, cuil, email, domicilio, entre_calles, codigo_postal, lat, lng, modalidad, fecha_nacimiento, condicion_fiscal_id,
          telefono_alt1, telefono_alt1_vinculo, telefono_alt2, telefono_alt2_vinculo } = req.body;
  if (!nombre || !telefono) {
    return res.status(400).json({ message: 'Nombre y Teléfono son requeridos' });
  }
  if (!dni) {
    return res.status(400).json({ message: 'El DNI es obligatorio' });
  }
  try {
    const db = await getPool();
    // Validar DNI duplicado (solo entre activos)
    const [dup] = await db.query('SELECT id, nombre FROM choferes WHERE dni = ? AND activo = 1 LIMIT 1', [dni]);
    if (dup.length > 0) {
      return res.status(409).json({ message: `Ya existe un chofer activo con DNI ${dni}: ${dup[0].nombre} (ID ${dup[0].id})` });
    }
    const uid = getUsuarioId(req);
    await db.query(`ALTER TABLE choferes ADD COLUMN IF NOT EXISTS telefono_alt1 VARCHAR(30) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE choferes ADD COLUMN IF NOT EXISTS telefono_alt1_vinculo VARCHAR(60) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE choferes ADD COLUMN IF NOT EXISTS telefono_alt2 VARCHAR(30) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE choferes ADD COLUMN IF NOT EXISTS telefono_alt2_vinculo VARCHAR(60) NULL`).catch(()=>{});
    const [result] = await db.query(`
      INSERT INTO choferes (nombre, telefono, telegram_chat_id, dni, cuil, email, domicilio, entre_calles, codigo_postal, lat, lng, modalidad, fecha_nacimiento, condicion_fiscal_id, activo, creado_por, creado_en, telefono_alt1, telefono_alt1_vinculo, telefono_alt2, telefono_alt2_vinculo, liquidacion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NOW(), ?, ?, ?, ?, ?)
    `, [nombre, telefono, req.body.telegram_chat_id||null, dni, cuil, email, domicilio, entre_calles||null, codigo_postal||null, lat||null, lng||null, modalidad, fecha_nacimiento, condicion_fiscal_id, uid,
        telefono_alt1||null, telefono_alt1_vinculo||null, telefono_alt2||null, telefono_alt2_vinculo||null, req.body.liquidacion||null]);
    await registrarAuditoria(req, 'choferes', 'crear', result.insertId, `Nuevo chofer: ${nombre}`);
    res.status(201).json({ message: 'Chofer registrado correctamente', id: result.insertId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.put('/api/choferes/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, telefono, telegram_chat_id, dni, cuil, email, domicilio, entre_calles, codigo_postal, lat, lng, modalidad, fecha_nacimiento, condicion_fiscal_id, activo,
          telefono_alt1, telefono_alt1_vinculo, telefono_alt2, telefono_alt2_vinculo } = req.body;
  if (!nombre || !telefono) {
    return res.status(400).json({ message: 'Nombre y Teléfono son requeridos' });
  }
  if (!dni) {
    return res.status(400).json({ message: 'El DNI es obligatorio' });
  }
  try {
    const db = await getPool();
    // Validar DNI duplicado (excluir propio registro e inactivos)
    const [dup] = await db.query('SELECT id, nombre FROM choferes WHERE dni = ? AND id != ? AND activo = 1 LIMIT 1', [dni, id]);
    if (dup.length > 0) {
      return res.status(409).json({ message: `Ya existe otro chofer activo con DNI ${dni}: ${dup[0].nombre} (ID ${dup[0].id})` });
    }
    const uid = getUsuarioId(req);
    await db.query(`ALTER TABLE choferes ADD COLUMN IF NOT EXISTS telefono_alt1 VARCHAR(30) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE choferes ADD COLUMN IF NOT EXISTS telefono_alt1_vinculo VARCHAR(60) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE choferes ADD COLUMN IF NOT EXISTS telefono_alt2 VARCHAR(30) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE choferes ADD COLUMN IF NOT EXISTS telefono_alt2_vinculo VARCHAR(60) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE choferes ADD COLUMN IF NOT EXISTS liquidacion VARCHAR(20) NULL`).catch(()=>{});
    const { liquidacion } = req.body;
    await db.query(`
      UPDATE choferes
      SET nombre = ?, telefono = ?, telegram_chat_id = ?, dni = ?, cuil = ?, email = ?, domicilio = ?, entre_calles = ?, codigo_postal = ?, lat = ?, lng = ?,
          modalidad = ?, fecha_nacimiento = ?, condicion_fiscal_id = ?, activo = ?,
          telefono_alt1 = ?, telefono_alt1_vinculo = ?, telefono_alt2 = ?, telefono_alt2_vinculo = ?,
          liquidacion = ?, modificado_por = ?, modificado_en = NOW()
      WHERE id = ?
    `, [nombre, telefono, telegram_chat_id||null, dni, cuil, email, domicilio, entre_calles||null, codigo_postal||null, lat||null, lng||null, modalidad, fecha_nacimiento, condicion_fiscal_id, activo !== undefined ? activo : 1,
        telefono_alt1||null, telefono_alt1_vinculo||null, telefono_alt2||null, telefono_alt2_vinculo||null,
        liquidacion||null, uid, id]);
    await registrarAuditoria(req, 'choferes', 'editar', id, `Chofer actualizado: ${nombre}`);
    res.json({ message: 'Chofer actualizado correctamente' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete('/api/choferes/:id', async (req, res) => {
  const { id } = req.params;
  if (!await checkPuedeEliminar(req, res)) return;
  try {
    const db = await getPool();
    const [ch] = await db.query('SELECT nombre FROM choferes WHERE id=?', [id]);
    const nombre = ch[0]?.nombre || id;
    try {
      await db.query('DELETE FROM choferes WHERE id = ?', [id]);
      await registrarAuditoria(req, 'choferes', 'eliminar', id, `Chofer eliminado permanentemente: ${nombre}`);
      res.json({ message: `Chofer "${nombre}" eliminado permanentemente.` });
    } catch (fkErr) {
      // Tiene registros asociados → baja lógica como fallback
      await db.query('UPDATE choferes SET activo = 0 WHERE id = ?', [id]);
      await registrarAuditoria(req, 'choferes', 'desactivar', id, `Chofer desactivado (tiene registros asociados): ${nombre}`);
      res.json({ message: `Chofer desactivado. Tiene registros históricos asociados que impiden la eliminación permanente.` });
    }
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 3. Vehículos (GET, POST, PUT, DELETE)
app.get('/api/vehiculos/titulares', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query(`
      SELECT DISTINCT titular_nombre, titular_cuit
      FROM vehiculos
      WHERE titular_nombre IS NOT NULL AND titular_nombre != ''
      ORDER BY titular_nombre
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/vehiculos', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query(`
      SELECT v.*, m.nombre as modelo_nombre, mr.nombre as marca_nombre, mr.id as marca_id,
        p.nombre AS persona_nombre, p.apellido AS persona_apellido, p.dni AS persona_dni, p.cuil AS persona_cuil,
        p.email AS persona_email, p.celular AS persona_celular,
        (SELECT vigencia_hasta FROM vehiculo_vtv WHERE vehiculo_id = v.id ORDER BY vigencia_hasta DESC LIMIT 1) as vtv_hasta,
        (SELECT vigencia_hasta FROM vehiculo_gnc WHERE vehiculo_id = v.id ORDER BY vigencia_hasta DESC LIMIT 1) as gnc_hasta,
        (SELECT vigencia_hasta FROM vehiculo_seguros WHERE vehiculo_id = v.id ORDER BY vigencia_hasta DESC LIMIT 1) as seguro_hasta,
        (SELECT a.nombre FROM vehiculo_seguros vs INNER JOIN aseguradoras a ON vs.aseguradora_id = a.id WHERE vs.vehiculo_id = v.id ORDER BY vs.vigencia_hasta DESC LIMIT 1) as seguro_compania
      FROM vehiculos v
      LEFT JOIN modelos m ON v.modelo_id = m.id
      LEFT JOIN marcas mr ON m.marca_id = mr.id
      LEFT JOIN personas p ON v.persona_id = p.id
      ORDER BY v.patente ASC
    `);
    
    // Retrocompatibilidad con marca y modelo como texto plano
    const mapped = rows.map(r => ({
      ...r,
      marca: r.marca_nombre || r.marca,
      modelo: r.modelo_nombre || r.modelo
    }));
    
    res.json(mapped);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/vehiculos', async (req, res) => {
  const { patente, color, nro_motor, nro_chasis, telepeaje_tag, telepeaje_responsable, modelo_id, fecha_alta, foto_principal,
          titular_nombre, titular_dni, titular_cuit, titular_domicilio, titular_codigo_postal, titular_lat, titular_lng, titular_email, titular_celular, tipo_vehiculo, uso, persona_id, año } = req.body;
  if (!patente) {
    return res.status(400).json({ message: 'La Patente es requerida' });
  }
  try {
    const db = await getPool();
    const [result] = await db.query(`
      INSERT INTO vehiculos (patente, color, nro_motor, nro_chasis, telepeaje_tag, telepeaje_responsable, modelo_id, fecha_alta, foto_principal, activo,
        titular_nombre, titular_dni, titular_cuit, titular_domicilio, titular_codigo_postal, titular_lat, titular_lng, titular_email, titular_celular, tipo_vehiculo, uso, persona_id, \`año\`)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [patente.toUpperCase(), color, nro_motor, nro_chasis, telepeaje_tag, telepeaje_responsable || 'propietario',
        modelo_id || null, fecha_alta || null, foto_principal || null,
        titular_nombre || null, titular_dni || null, titular_cuit || null, titular_domicilio || null, titular_codigo_postal || null,
        titular_lat || null, titular_lng || null, titular_email || null, titular_celular || null, tipo_vehiculo || null, uso || null,
        persona_id || null, año || null]);
    await registrarAuditoria(req, 'vehiculos', 'crear', result.insertId, `Nuevo vehículo: ${patente.toUpperCase()}`);
    res.status(201).json({ message: 'Vehículo registrado correctamente', id: result.insertId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.put('/api/vehiculos/:id', async (req, res) => {
  const { id } = req.params;
  const { patente, color, nro_motor, nro_chasis, telepeaje_tag, telepeaje_responsable, modelo_id, fecha_alta, fecha_baja, motivo_baja, foto_principal, activo,
          titular_nombre, titular_dni, titular_cuit, titular_domicilio, titular_codigo_postal, titular_lat, titular_lng, titular_email, titular_celular, tipo_vehiculo, uso, persona_id, año } = req.body;
  if (!patente) {
    return res.status(400).json({ message: 'La Patente es requerida' });
  }
  try {
    const db = await getPool();
    await db.query(`
      UPDATE vehiculos
      SET patente = ?, color = ?, nro_motor = ?, nro_chasis = ?, telepeaje_tag = ?,
          telepeaje_responsable = ?, modelo_id = ?, fecha_alta = ?, fecha_baja = ?, motivo_baja = ?, foto_principal = ?, activo = ?,
          titular_nombre = ?, titular_dni = ?, titular_cuit = ?, titular_domicilio = ?, titular_codigo_postal = ?, titular_lat = ?, titular_lng = ?,
          titular_email = ?, titular_celular = ?, tipo_vehiculo = ?, uso = ?, persona_id = ?, \`año\` = ?
      WHERE id = ?
    `, [patente.toUpperCase(), color, nro_motor, nro_chasis, telepeaje_tag, telepeaje_responsable,
        modelo_id || null, fecha_alta || null, fecha_baja || null, motivo_baja || null, foto_principal || null,
        activo !== undefined ? activo : 1,
        titular_nombre || null, titular_dni || null, titular_cuit || null, titular_domicilio || null, titular_codigo_postal || null,
        titular_lat || null, titular_lng || null, titular_email || null, titular_celular || null, tipo_vehiculo || null, uso || null,
        persona_id || null, año || null,
        id]);
    await registrarAuditoria(req, 'vehiculos', 'editar', id, `Vehículo actualizado: ${patente.toUpperCase()}`);
    res.json({ message: 'Vehículo actualizado correctamente' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete('/api/vehiculos/:id', async (req, res) => {
  const { id } = req.params;
  const { motivo_baja } = req.body || {};
  const today = new Date().toISOString().split('T')[0];
  if (!await checkPuedeEliminar(req, res)) return;
  try {
    const db = await getPool();
    const [vh] = await db.query('SELECT patente FROM vehiculos WHERE id=?', [id]);
    try {
      await db.query('DELETE FROM vehiculos WHERE id = ?', [id]);
      await registrarAuditoria(req, 'vehiculos', 'eliminar', id, `Vehículo eliminado: ${vh[0]?.patente||id}`);
      res.json({ message: 'Vehículo eliminado con éxito de la base de datos' });
    } catch (fkErr) {
      await db.query(`
        UPDATE vehiculos
        SET activo = 0, fecha_baja = ?, motivo_baja = ?
        WHERE id = ?
      `, [today, motivo_baja || 'Baja por dependencias del sistema (Services/Multas)', id]);
      await registrarAuditoria(req, 'vehiculos', 'desactivar', id, `Vehículo desactivado: ${vh[0]?.patente||id}`);
      res.json({ message: 'Vehículo desactivado lógicamente debido a que tiene registros de servicios/multas vinculados.' });
    }
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 4. Proveedores (GET, POST, PUT, DELETE)
app.get('/api/proveedores', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM proveedores ORDER BY nombre ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/proveedores', async (req, res) => {
  const { nombre, cuit, telefono, direccion, rubro, email, condicion_fiscal_id, lat, lng, alias, cbu_cvu } = req.body;
  if (!nombre) return res.status(400).json({ message: 'El Nombre del proveedor es obligatorio' });
  try {
    const db = await getPool();
    const [result] = await db.query(`
      INSERT INTO proveedores (nombre, cuit, telefono, direccion, rubro, email, condicion_fiscal_id, lat, lng, alias, cbu_cvu, activo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `, [nombre, cuit||null, telefono||null, direccion||null, rubro||null, email||null, condicion_fiscal_id||null, lat||null, lng||null, alias||null, cbu_cvu||null]);
    await registrarAuditoria(req, 'proveedores', 'crear', result.insertId, `Nuevo proveedor: ${nombre}`);
    res.status(201).json({ message: 'Proveedor registrado correctamente', id: result.insertId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.put('/api/proveedores/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, cuit, telefono, direccion, rubro, activo, email, condicion_fiscal_id, lat, lng, alias, cbu_cvu } = req.body;
  if (!nombre) return res.status(400).json({ message: 'El Nombre del proveedor es obligatorio' });
  try {
    const db = await getPool();
    await db.query(`
      UPDATE proveedores
      SET nombre=?, cuit=?, telefono=?, direccion=?, rubro=?, email=?, condicion_fiscal_id=?, lat=?, lng=?, alias=?, cbu_cvu=?, activo=?
      WHERE id=?
    `, [nombre, cuit||null, telefono||null, direccion||null, rubro||null, email||null, condicion_fiscal_id||null, lat||null, lng||null, alias||null, cbu_cvu||null, activo !== undefined ? activo : 1, id]);
    await registrarAuditoria(req, 'proveedores', 'editar', id, `Proveedor actualizado: ${nombre}`);
    res.json({ message: 'Proveedor actualizado correctamente' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete('/api/proveedores/:id', async (req, res) => {
  const { id } = req.params;
  if (!await checkPuedeEliminar(req, res)) return;
  try {
    const db = await getPool();
    const [pv] = await db.query('SELECT nombre FROM proveedores WHERE id=?', [id]);
    try {
      await db.query('DELETE FROM proveedores WHERE id = ?', [id]);
      await registrarAuditoria(req, 'proveedores', 'eliminar', id, `Proveedor eliminado: ${pv[0]?.nombre||id}`);
      res.json({ message: 'Proveedor eliminado de la base de datos' });
    } catch (fkErr) {
      await db.query('UPDATE proveedores SET activo = 0 WHERE id = ?', [id]);
      await registrarAuditoria(req, 'proveedores', 'desactivar', id, `Proveedor desactivado: ${pv[0]?.nombre||id}`);
      res.json({ message: 'Proveedor desactivado lógicamente debido a que está asociado a servicios realizados.' });
    }
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Sucursales de proveedores
app.get('/api/proveedores/:id/sucursales', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM proveedor_sucursales WHERE proveedor_id = ? ORDER BY nombre ASC', [req.params.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/proveedores/:id/sucursales', async (req, res) => {
  const { nombre, domicilio, entre_calles, codigo_postal, lat, lng, telefono, email } = req.body;
  if (!nombre) return res.status(400).json({ message: 'Nombre requerido' });
  try {
    const db = await getPool();
    const [r] = await db.query(
      'INSERT INTO proveedor_sucursales (proveedor_id, nombre, domicilio, entre_calles, codigo_postal, lat, lng, telefono, email) VALUES (?,?,?,?,?,?,?,?,?)',
      [req.params.id, nombre, domicilio||null, entre_calles||null, codigo_postal||null, lat||null, lng||null, telefono||null, email||null]
    );
    await registrarAuditoria(req, 'proveedores', 'sucursal-crear', r.insertId, `Sucursal creada: ${nombre} (proveedor_id=${req.params.id})`);
    res.status(201).json({ message: 'Sucursal creada', id: r.insertId });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put('/api/proveedores/:id/sucursales/:sid', async (req, res) => {
  const { nombre, domicilio, entre_calles, codigo_postal, lat, lng, telefono, email } = req.body;
  try {
    const db = await getPool();
    await db.query(
      'UPDATE proveedor_sucursales SET nombre=?, domicilio=?, entre_calles=?, codigo_postal=?, lat=?, lng=?, telefono=?, email=? WHERE id=? AND proveedor_id=?',
      [nombre, domicilio||null, entre_calles||null, codigo_postal||null, lat||null, lng||null, telefono||null, email||null, req.params.sid, req.params.id]
    );
    await registrarAuditoria(req, 'proveedores', 'sucursal-editar', req.params.sid, `Sucursal actualizada: ${nombre} (proveedor_id=${req.params.id})`);
    res.json({ message: 'Sucursal actualizada' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/proveedores/:id/sucursales/:sid', async (req, res) => {
  try {
    const db = await getPool();
    const [[sc]] = await db.query('SELECT nombre FROM proveedor_sucursales WHERE id=?', [req.params.sid]);
    await db.query('DELETE FROM proveedor_sucursales WHERE id=? AND proveedor_id=?', [req.params.sid, req.params.id]);
    await registrarAuditoria(req, 'proveedores', 'sucursal-eliminar', req.params.sid, `Sucursal eliminada: ${sc?.nombre||req.params.sid} (proveedor_id=${req.params.id})`);
    res.json({ message: 'Sucursal eliminada' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Geocodificación con Nominatim (proxy para evitar CORS)
app.get('/api/geocode', async (req, res) => {
  const { address } = req.query;
  if (!address) return res.status(400).json({ message: 'address requerida' });
  try {
    const https = require('https');
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=ar`;
    https.get(url, { headers: { 'User-Agent': 'FlotaControl/1.0' } }, (apiRes) => {
      let data = '';
      apiRes.on('data', c => data += c);
      apiRes.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.length > 0) {
            res.json({ lat: parseFloat(json[0].lat), lng: parseFloat(json[0].lon), display: json[0].display_name });
          } else {
            res.json({ lat: null, lng: null, display: null });
          }
        } catch(e) { res.status(500).json({ message: 'Parse error' }); }
      });
    }).on('error', e => res.status(500).json({ message: e.message }));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// 5. Condiciones Fiscales
app.get('/api/condiciones-fiscales', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM condiciones_fiscales ORDER BY id ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Bancos/fintechs — CRUD completo
app.get('/api/bancos', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM bancos ORDER BY tipo, nombre');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/bancos', async (req, res) => {
  const { nombre, tipo, codigo_bcra, cvu_prefix, logo_emoji } = req.body;
  if (!nombre) return res.status(400).json({ message: 'Nombre requerido' });
  try {
    const db = await getPool();
    const [r] = await db.query(
      'INSERT INTO bancos (nombre,tipo,codigo_bcra,cvu_prefix,logo_emoji) VALUES (?,?,?,?,?)',
      [nombre, tipo||'banco', codigo_bcra||null, cvu_prefix||null, logo_emoji||null]
    );
    await registrarAuditoria(req, 'bancos', 'crear', r.insertId, `Banco creado: ${nombre}`);
    res.status(201).json({ id: r.insertId });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put('/api/bancos/:id', async (req, res) => {
  const { nombre, tipo, codigo_bcra, cvu_prefix, logo_emoji } = req.body;
  if (!nombre) return res.status(400).json({ message: 'Nombre requerido' });
  try {
    const db = await getPool();
    await db.query(
      'UPDATE bancos SET nombre=?,tipo=?,codigo_bcra=?,cvu_prefix=?,logo_emoji=? WHERE id=?',
      [nombre, tipo||'banco', codigo_bcra||null, cvu_prefix||null, logo_emoji||null, req.params.id]
    );
    await registrarAuditoria(req, 'bancos', 'editar', req.params.id, `Banco actualizado: ${nombre}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/bancos/:id', async (req, res) => {
  try {
    const db = await getPool();
    const [[bk]] = await db.query('SELECT nombre FROM bancos WHERE id=?', [req.params.id]);
    await db.query('DELETE FROM bancos WHERE id=?', [req.params.id]);
    await registrarAuditoria(req, 'bancos', 'eliminar', req.params.id, `Banco eliminado: ${bk?.nombre||req.params.id}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// 6. Cuentas
app.get('/api/cuentas', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query(`
      SELECT c.id, c.alias, c.nombre, c.apellido, c.dni, c.cuil, c.cbu_cvu, c.banco_id, c.persona_id,
             b.nombre AS banco_nombre, b.logo_emoji AS banco_emoji, b.tipo AS banco_tipo,
             p.nombre AS persona_nombre, p.apellido AS persona_apellido, p.dni AS persona_dni
      FROM cuentas c
      LEFT JOIN bancos   b ON c.banco_id  = b.id
      LEFT JOIN personas p ON c.persona_id = p.id
      ORDER BY c.alias ASC`);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/cuentas', async (req, res) => {
  const { alias, nombre, apellido, dni, cuil, cbu_cvu, banco_id, persona_id } = req.body;
  if (!alias) return res.status(400).json({ message: 'El Alias es requerido' });
  try {
    const db = await getPool();
    const [dup] = await db.query('SELECT id FROM cuentas WHERE alias=?', [alias]);
    if (dup.length) return res.status(409).json({ message: 'Ya existe una cuenta con ese alias' });
    const [r] = await db.query(
      'INSERT INTO cuentas (alias,nombre,apellido,dni,cuil,cbu_cvu,banco_id,persona_id) VALUES (?,?,?,?,?,?,?,?)',
      [alias, nombre||null, apellido||null, dni||null, cuil||null, cbu_cvu||null, banco_id||null, persona_id||null]
    );
    await registrarAuditoria(req, 'cuentas', 'crear', r.insertId, `Nueva cuenta: ${alias}`);
    res.status(201).json({ id: r.insertId });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put('/api/cuentas/:id', async (req, res) => {
  const { alias, nombre, apellido, dni, cuil, cbu_cvu, banco_id, persona_id } = req.body;
  if (!alias) return res.status(400).json({ message: 'El Alias es requerido' });
  try {
    const db = await getPool();
    const [dup] = await db.query('SELECT id FROM cuentas WHERE alias=? AND id<>?', [alias, req.params.id]);
    if (dup.length) return res.status(409).json({ message: 'Ya existe otra cuenta con ese alias' });
    await db.query(
      'UPDATE cuentas SET alias=?,nombre=?,apellido=?,dni=?,cuil=?,cbu_cvu=?,banco_id=?,persona_id=? WHERE id=?',
      [alias, nombre||null, apellido||null, dni||null, cuil||null, cbu_cvu||null, banco_id||null, persona_id||null, req.params.id]
    );
    await registrarAuditoria(req, 'cuentas', 'editar', req.params.id, `Cuenta editada: ${alias}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/cuentas/:id', async (req, res) => {
  if (!await checkPuedeEliminar(req, res)) return;
  try {
    const db = await getPool();
    const [cu] = await db.query('SELECT alias FROM cuentas WHERE id=?', [req.params.id]);
    await db.query('DELETE FROM cuentas WHERE id=?', [req.params.id]);
    await registrarAuditoria(req, 'cuentas', 'eliminar', req.params.id, `Cuenta eliminada: ${cu[0]?.alias}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// 7. Services
app.get('/api/services', async (req, res) => {
  try {
    const db = await getPool();
    const { vehiculo_id, proveedor_id, desde, hasta } = req.query;
    const where = []; const vals = [];
    if (vehiculo_id)  { where.push('s.vehiculo_id=?');  vals.push(vehiculo_id); }
    if (proveedor_id) { where.push('s.proveedor_id=?'); vals.push(proveedor_id); }
    if (desde)        { where.push('s.fecha>=?');       vals.push(desde); }
    if (hasta)        { where.push('s.fecha<=?');       vals.push(hasta); }
    const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [rows] = await db.query(`
      SELECT s.*, v.patente, v.marca, v.modelo, p.nombre as proveedor
      FROM services s
      INNER JOIN vehiculos v ON s.vehiculo_id = v.id
      LEFT JOIN proveedores p ON s.proveedor_id = p.id
      ${cond}
      ORDER BY s.fecha DESC
    `, vals);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Services CRUD
app.post('/api/services', async (req, res) => {
  const { vehiculo_id, proveedor_id, tipo, descripcion, costo, fecha, kilometraje, km_intervalo, km_proximo, notas,
          factura_tipo, factura_numero, factura_fecha, factura_proveedor, factura_proveedor_id,
          factura_tipo_auth, factura_cae, factura_cae_vto,
          factura_subtotal, factura_iva, factura_total, factura_items, factura_receptor, factura_url,
          diagnostico_json } = req.body;
  if (!vehiculo_id || !tipo) return res.status(400).json({ message: 'vehiculo_id y tipo son obligatorios' });
  try {
    const db = await getPool();
    const [r] = await db.query(
      `INSERT INTO services (
        vehiculo_id, proveedor_id, tipo, descripcion, costo, fecha, kilometraje, km_intervalo, km_proximo, notas,
        factura_tipo, factura_numero, factura_fecha, factura_proveedor, factura_proveedor_id,
        factura_tipo_auth, factura_cae, factura_cae_vto,
        factura_subtotal, factura_iva, factura_total, factura_items, factura_receptor, factura_url,
        diagnostico_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [vehiculo_id, proveedor_id||null, tipo, descripcion||null, costo||null, fecha||null, kilometraje||null, km_intervalo||null, km_proximo||null, notas||null,
       factura_tipo||null, factura_numero||null, factura_fecha||null, factura_proveedor||null, factura_proveedor_id||null,
       factura_tipo_auth||null, factura_cae||null, factura_cae_vto||null,
       factura_subtotal||null, factura_iva||null, factura_total||null, factura_items||null, factura_receptor||null, factura_url||null,
       diagnostico_json ? JSON.stringify(diagnostico_json) : null]
    );
    const [[vhS]] = await db.query('SELECT patente FROM vehiculos WHERE id=?', [vehiculo_id]);
    await registrarAuditoria(req, 'services', 'crear', r.insertId, `Service #${r.insertId} — ${vhS?.patente||'?'} · ${tipo}${descripcion ? ' — ' + descripcion : ''} · ${fecha||''}`);
    res.status(201).json({ message: 'Service registrado', id: r.insertId });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put('/api/services/:id', async (req, res) => {
  const { vehiculo_id, proveedor_id, tipo, descripcion, costo, fecha, kilometraje, km_intervalo, km_proximo, notas,
          factura_tipo, factura_numero, factura_fecha, factura_proveedor, factura_proveedor_id,
          factura_tipo_auth, factura_cae, factura_cae_vto,
          factura_subtotal, factura_iva, factura_total, factura_items, factura_receptor, factura_url,
          diagnostico_json } = req.body;
  const userId = req.session?.user?.id || null;
  const now = new Date();
  try {
    const db = await getPool();
    // Verificar si la factura fue cargada ahora (campos nuevos) para registrar auditoría
    const [prev] = await db.query('SELECT factura_numero, factura_cargado_por FROM services WHERE id=?', [req.params.id]);
    const facturaChanged = prev[0] && factura_numero && prev[0].factura_numero !== factura_numero;
    const factCargadoPor = facturaChanged || !prev[0]?.factura_cargado_por ? userId : prev[0].factura_cargado_por;
    const factCargadoAt  = facturaChanged || !prev[0]?.factura_cargado_por ? now : undefined;

    const setCols = [
      'vehiculo_id=?','proveedor_id=?','tipo=?','descripcion=?','costo=?','fecha=?',
      'kilometraje=?','km_intervalo=?','km_proximo=?','notas=?',
      'factura_tipo=?','factura_numero=?','factura_fecha=?',
      'factura_proveedor=?','factura_proveedor_id=?','factura_tipo_auth=?',
      'factura_cae=?','factura_cae_vto=?',
      'factura_subtotal=?','factura_iva=?','factura_total=?','factura_items=?','factura_receptor=?','factura_url=?',
      'factura_cargado_por=?',
      'diagnostico_json=?',
      'modificado_por=?','modificado_at=?'
    ];
    const vals = [
      vehiculo_id, proveedor_id||null, tipo, descripcion||null, costo||null, fecha||null,
      kilometraje||null, km_intervalo||null, km_proximo||null, notas||null,
      factura_tipo||null, factura_numero||null, factura_fecha||null,
      factura_proveedor||null, factura_proveedor_id||null, factura_tipo_auth||null,
      factura_cae||null, factura_cae_vto||null,
      factura_subtotal||null, factura_iva||null, factura_total||null, factura_items||null, factura_receptor||null, factura_url||null,
      factCargadoPor,
      diagnostico_json !== undefined ? JSON.stringify(diagnostico_json) : null,
      userId, now,
      req.params.id
    ];
    if (factCargadoAt) { setCols.push('factura_cargado_at=?'); vals.splice(vals.length-1, 0, factCargadoAt); }

    await db.query(`UPDATE services SET ${setCols.join(',')} WHERE id=?`, vals);
    await registrarAuditoria(req, 'services', 'modificar', req.params.id, `Service actualizado${factura_numero ? ` · Factura ${factura_numero}` : ''}`);
    res.json({ message: 'Service actualizado' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/services/:id', async (req, res) => {
  if (!await checkPuedeEliminar(req, res)) return;
  try {
    const db = await getPool();
    const [sv] = await db.query('SELECT descripcion FROM services WHERE id=?', [req.params.id]);
    await db.query('DELETE FROM services WHERE id=?', [req.params.id]);
    await registrarAuditoria(req, 'services', 'eliminar', req.params.id, `Service eliminado: ${sv[0]?.descripcion||req.params.id}`);
    res.json({ message: 'Service eliminado' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/services/:id/fotos', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM service_fotos WHERE service_id=? ORDER BY fecha_subida ASC', [req.params.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/services/:id/fotos', (req, res, next) => uploadServiceFoto.array('fotos', 10)(req, res, next), async (req, res) => {
  try {
    const db = await getPool();
    for (const file of req.files) {
      const url = `/uploads/services/${req.params.id}/${file.filename}`;
      await db.query('INSERT INTO service_fotos (service_id, url) VALUES (?,?)', [req.params.id, url]);
    }
    await registrarAuditoria(req, 'services', 'fotos-subir', req.params.id, `${req.files.length} foto(s) subida(s) al service ${req.params.id}`);
    res.status(201).json({ message: `${req.files.length} foto(s) subida(s)` });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/services/:id/fotos/:fid', async (req, res) => {
  try {
    const db = await getPool();
    const [[foto]] = await db.query('SELECT url FROM service_fotos WHERE id=?', [req.params.fid]);
    if (foto) {
      const fs = require('fs');
      const filePath = `./public${foto.url}`;
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      await db.query('DELETE FROM service_fotos WHERE id=?', [req.params.fid]);
    }
    await registrarAuditoria(req, 'services', 'foto-eliminar', req.params.id, `Foto eliminada (service_id=${req.params.id}, foto_id=${req.params.fid})`);
    res.json({ message: 'Foto eliminada' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Tarjetas de crédito/débito ────────────────────────────────────────────
app.get('/api/tarjetas', async (req, res) => {
  try {
    const db = await getPool();
    const personaFilter = req.query.persona_id ? ' WHERE t.persona_id = ?' : '';
    const filterVals = req.query.persona_id ? [req.query.persona_id] : [];
    const [rows] = await db.query(`
      SELECT t.id, t.persona_id, t.banco_id, t.marca, t.ultimos_4, t.activo, t.created_at,
             b.nombre AS banco_nombre, b.logo_emoji AS banco_emoji,
             CONCAT(IFNULL(p.apellido,''),' ',IFNULL(p.nombre,'')) AS persona_nombre,
             t.nro_tarjeta_enc IS NOT NULL AND t.nro_tarjeta_enc <> '' AS tiene_nro
      FROM tarjetas t
      LEFT JOIN bancos   b ON b.id = t.banco_id
      LEFT JOIN personas p ON p.id = t.persona_id
      ${personaFilter}
      ORDER BY t.marca, b.nombre
    `, filterVals);
    // devolver número enmascarado si está guardado
    for (const row of rows) {
      row.nro_mascara = null;
      if (row.nro_tarjeta_enc) {
        // necesitamos DNI+Apellido de la persona para descifrar y enmascarar
        // pero enmascarar no requiere descifrar — guardamos también la máscara? No, descifrar para enmascarar
        // Obtenemos persona
        const [ps] = await db.query('SELECT dni, apellido FROM personas WHERE id=?', [row.persona_id]);
        const p2 = ps[0] || {};
        const nro = decryptCardNro(row.nro_tarjeta_enc, p2.dni, p2.apellido);
        row.nro_mascara = nro ? maskCardNro(nro) : null;
      }
      delete row.nro_tarjeta_enc;
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Endpoint para obtener número completo (descifrado)
app.get('/api/tarjetas/:id/numero', async (req, res) => {
  try {
    const db = await getPool();
    const [[t]] = await db.query('SELECT t.nro_tarjeta_enc, p.dni, p.apellido FROM tarjetas t LEFT JOIN personas p ON p.id=t.persona_id WHERE t.id=?', [req.params.id]);
    if (!t) return res.status(404).json({ message: 'No encontrado' });
    const nro = decryptCardNro(t.nro_tarjeta_enc, t.dni, t.apellido);
    res.json({ nro: nro || '' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/tarjetas', async (req, res) => {
  const { persona_id, banco_id, marca, nro_tarjeta } = req.body;
  if (!marca) return res.status(400).json({ message: 'La marca es obligatoria' });
  try {
    const db = await getPool();
    const [[persona]] = await db.query('SELECT dni, apellido FROM personas WHERE id=?', [persona_id||0]);
    const p = persona || {};
    const digits   = (nro_tarjeta || '').replace(/\D/g, '');
    const ultimos4 = digits.length >= 4 ? digits.slice(-4) : (digits || null);
    const enc      = digits ? encryptCardNro(digits, p.dni, p.apellido) : null;
    const [r] = await db.query(
      'INSERT INTO tarjetas (persona_id, banco_id, marca, ultimos_4, nro_tarjeta_enc) VALUES (?,?,?,?,?)',
      [persona_id||null, banco_id||null, marca, ultimos4, enc]
    );
    await registrarAuditoria(req, 'tarjetas', 'crear', r.insertId, `Tarjeta creada: ${marca}${ultimos4 ? ` ····${ultimos4}` : ''}${p.apellido ? ` — ${p.apellido}` : ''}`);
    res.status(201).json({ id: r.insertId });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put('/api/tarjetas/:id', async (req, res) => {
  const { persona_id, banco_id, marca, nro_tarjeta, activo } = req.body;
  try {
    const db = await getPool();
    const [[persona]] = await db.query('SELECT dni, apellido FROM personas WHERE id=?', [persona_id||0]);
    const p = persona || {};
    const digits   = (nro_tarjeta || '').replace(/\D/g, '');
    const ultimos4 = digits.length >= 4 ? digits.slice(-4) : (digits || null);
    const enc      = digits ? encryptCardNro(digits, p.dni, p.apellido) : null;
    // Si no se envió número nuevo (campo vacío), conservar el existente
    if (nro_tarjeta === undefined || nro_tarjeta === null) {
      await db.query(
        'UPDATE tarjetas SET persona_id=?, banco_id=?, marca=?, activo=? WHERE id=?',
        [persona_id||null, banco_id||null, marca, activo??1, req.params.id]
      );
    } else {
      await db.query(
        'UPDATE tarjetas SET persona_id=?, banco_id=?, marca=?, ultimos_4=?, nro_tarjeta_enc=?, activo=? WHERE id=?',
        [persona_id||null, banco_id||null, marca, ultimos4, enc, activo??1, req.params.id]
      );
    }
    await registrarAuditoria(req, 'tarjetas', 'editar', req.params.id, `Tarjeta actualizada: ${marca}${ultimos4 ? ` ····${ultimos4}` : ''}${p.apellido ? ` — ${p.apellido}` : ''}`);
    res.json({ message: 'ok' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/tarjetas/:id', async (req, res) => {
  if (!await checkPuedeEliminar(req, res)) return;
  try {
    const db = await getPool();
    const [[td]] = await db.query('SELECT marca, ultimos_4 FROM tarjetas WHERE id=?', [req.params.id]);
    await db.query('DELETE FROM tarjetas WHERE id=?', [req.params.id]);
    await registrarAuditoria(req, 'tarjetas', 'eliminar', req.params.id, `Tarjeta eliminada: ${td?.marca||''}${td?.ultimos_4 ? ` ····${td.ultimos_4}` : ''}`);
    res.json({ message: 'ok' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Service pagos (multi-pago) ────────────────────────────────────────────
app.get('/api/services/:id/pagos', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query(`
      SELECT sp.*, c.alias AS cuenta_alias, t.marca AS tarjeta_marca, t.ultimos_4, t.banco_nombre AS tarjeta_banco
      FROM service_pagos sp
      LEFT JOIN cuentas  c ON c.id = sp.cuenta_id
      LEFT JOIN tarjetas t ON t.id = sp.tarjeta_id
      WHERE sp.service_id = ?
      ORDER BY sp.id
    `, [req.params.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/services/:id/pagos', async (req, res) => {
  // Reemplaza todos los pagos del service (array en body)
  const pagos = req.body; // [{medio, monto, cuenta_id, tarjeta_id, cuotas, notas, comprobante_url}]
  if (!Array.isArray(pagos)) return res.status(400).json({ message: 'Se esperaba un array de pagos' });
  try {
    const db = await getPool();
    await db.query('DELETE FROM service_pagos WHERE service_id=?', [req.params.id]);
    for (const p of pagos) {
      if (!p.monto || !p.medio) continue;
      await db.query(
        'INSERT INTO service_pagos (service_id, medio, monto, cuenta_id, tarjeta_id, cuotas, notas, comprobante_url) VALUES (?,?,?,?,?,?,?,?)',
        [req.params.id, p.medio, p.monto, p.cuenta_id||null, p.tarjeta_id||null, p.cuotas||1, p.notas||null, p.comprobante_url||null]
      );
    }
    await registrarAuditoria(req, 'services', 'pagos-guardar', req.params.id, `Pagos guardados para service ${req.params.id}: ${pagos.length} ítem(s)`);
    res.json({ message: 'Pagos guardados' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/upload/svc-pago-comprobante', memUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Sin archivo' });
    const pathM = require('path'), fs = require('fs');
    const dir = pathM.join(__dirname, 'public', 'uploads', 'services');
    fs.mkdirSync(dir, { recursive: true });
    const ext = req.file.originalname.split('.').pop() || 'jpg';
    const fname = `comprobante_${Date.now()}.${ext}`;
    fs.writeFileSync(pathM.join(dir, fname), req.file.buffer);
    res.json({ url: `/uploads/services/${fname}` });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// 8. Multas
app.get('/api/multas/check-actas', async (req, res) => {
  try {
    const db  = await getPool();
    const actas = [].concat(req.query.acta || []).filter(Boolean);
    if (!actas.length) return res.json([]);
    const placeholders = actas.map(() => '?').join(',');
    const [rows] = await db.query(`SELECT numero_acta FROM multas WHERE numero_acta IN (${placeholders})`, actas);
    res.json(rows.map(r => r.numero_acta));
  } catch(err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/multas', async (req, res) => {
  try {
    const db = await getPool();
    const { chofer_id, vehiculo_id, estado, desde, hasta, municipalidad_id } = req.query;
    let where = [];
    const vals = [];
    if (chofer_id === 'sin_asignar') {
      where.push('m.chofer_id IS NULL');
    } else if (chofer_id) {
      where.push('m.chofer_id = ?');
      vals.push(chofer_id);
    }
    if (vehiculo_id) {
      where.push('m.vehiculo_id = ?');
      vals.push(vehiculo_id);
    }
    if (estado) {
      where.push('m.estado = ?');
      vals.push(estado);
    }
    if (desde) {
      where.push('m.fecha_infraccion >= ?');
      vals.push(desde);
    }
    if (hasta) {
      where.push('m.fecha_infraccion <= ?');
      vals.push(hasta);
    }
    if (municipalidad_id) {
      where.push('m.municipalidad_id = ?');
      vals.push(municipalidad_id);
    }
    const [rows] = await db.query(`
      SELECT m.*, v.patente, v.marca, v.modelo,
             c.nombre as chofer_nombre,
             mun.nombre as municipalidad_nombre,
             (SELECT tipo FROM multa_adjuntos WHERE multa_id = m.id ORDER BY fecha_subida ASC LIMIT 1) AS primer_adj_tipo,
             (SELECT COUNT(*) FROM multa_adjuntos WHERE multa_id = m.id) AS adj_count
      FROM multas m
      INNER JOIN vehiculos v ON m.vehiculo_id = v.id
      LEFT JOIN choferes c ON m.chofer_id = c.id
      LEFT JOIN municipalidades mun ON m.municipalidad_id = mun.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY m.fecha_infraccion DESC
    `, vals);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message }); }
});

// Busca el chofer que tenía el vehículo al momento de la infracción
app.get('/api/multas/:id/buscar-chofer', async (req, res) => {
  try {
    const db = await getPool();
    const [[multa]] = await db.query(
      'SELECT vehiculo_id, fecha_infraccion, hora_infraccion FROM multas WHERE id = ?',
      [req.params.id]
    );
    if (!multa) return res.status(404).json({ message: 'Multa no encontrada' });
    if (!multa.fecha_infraccion) return res.json({ found: false, reason: 'Sin fecha de infracción' });

    const [[turno]] = await db.query(`
      SELECT t.id, t.chofer_id, ch.nombre AS chofer_nombre,
             t.fecha_inicio, t.fecha_fin
      FROM turnos t
      JOIN choferes ch ON ch.id = t.chofer_id
      WHERE t.vehiculo_id = ?
        AND t.fecha_inicio <= DATE_ADD(?, INTERVAL TIME_TO_SEC(IFNULL(?,'00:00:00')) SECOND)
        AND (t.fecha_fin IS NULL OR t.fecha_fin >= DATE_ADD(?, INTERVAL TIME_TO_SEC(IFNULL(?,'00:00:00')) SECOND))
      ORDER BY t.fecha_inicio DESC
      LIMIT 1
    `, [multa.vehiculo_id, multa.fecha_infraccion, multa.hora_infraccion, multa.fecha_infraccion, multa.hora_infraccion]);

    if (!turno) return res.json({ found: false, reason: 'Ningún turno cubre ese horario' });
    res.json({ found: true, chofer_id: turno.chofer_id, chofer_nombre: turno.chofer_nombre,
               turno_id: turno.id, fecha_inicio: turno.fecha_inicio, fecha_fin: turno.fecha_fin });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/multas', async (req, res) => {
  const { vehiculo_id, chofer_id, municipalidad_id, fecha_infraccion, hora_infraccion, numero_acta, descripcion, articulo_infringido, lugar, monto, monto_voluntario, monto_total, puntos, fecha_vencimiento, fecha_vto_voluntario, fecha_vto_total, url_consulta, estado, nombre_infractor, dni_infractor, notas,
          fecha_emision_acta, fecha_notificacion, medio_notificacion, codigo_seguimiento_postal, constancia_recepcion,
          fecha_pago, medio_pago_multa, nro_operacion_pago, cuenta_id_pago, tarjeta_id_pago, cuotas_pago } = req.body;
  if (!vehiculo_id || !descripcion) return res.status(400).json({ message: 'vehiculo_id y descripción son obligatorios' });
  const _montoVol  = monto_voluntario || monto || null;
  const _fVtoVol   = fecha_vto_voluntario || fecha_vencimiento || null;
  try {
    const db = await getPool();
    const [r] = await db.query(
      `INSERT INTO multas (vehiculo_id, chofer_id, municipalidad_id, fecha_infraccion, hora_infraccion, numero_acta, descripcion, articulo_infringido, lugar, monto, monto_voluntario, monto_total, puntos, fecha_vencimiento, fecha_vto_voluntario, fecha_vto_total, url_consulta, estado, nombre_infractor, dni_infractor, notas,
                           fecha_emision_acta, fecha_notificacion, medio_notificacion, codigo_seguimiento_postal, constancia_recepcion,
                           fecha_pago, medio_pago_multa, nro_operacion_pago, cuenta_id_pago, tarjeta_id_pago, cuotas_pago)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [vehiculo_id, chofer_id||null, municipalidad_id||null, fecha_infraccion||null, hora_infraccion||null, numero_acta||null, descripcion, articulo_infringido||null, lugar||null,
       _montoVol, _montoVol, monto_total||null,
       puntos||null, _fVtoVol, _fVtoVol, fecha_vto_total||null,
       url_consulta||null, estado||'pendiente', nombre_infractor||null, dni_infractor||null, notas||null,
       fecha_emision_acta||null, fecha_notificacion||null, medio_notificacion||null, codigo_seguimiento_postal||null, constancia_recepcion ? 1 : 0,
       fecha_pago||null, medio_pago_multa||null, nro_operacion_pago||null, cuenta_id_pago||null, tarjeta_id_pago||null, cuotas_pago||null]
    );
    await registrarAuditoria(req, 'multas', 'crear', r.insertId, `Multa registrada${numero_acta ? ': acta ' + numero_acta : ''} — ${descripcion}`);
    res.status(201).json({ message: 'Infracción registrada', id: r.insertId });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put('/api/multas/:id', async (req, res) => {
  const { vehiculo_id, chofer_id, municipalidad_id, fecha_infraccion, hora_infraccion, numero_acta, descripcion, articulo_infringido, lugar, monto, monto_voluntario, monto_total, puntos, fecha_vencimiento, fecha_vto_voluntario, fecha_vto_total, url_consulta, estado, nombre_infractor, dni_infractor, notas,
          fecha_emision_acta, fecha_notificacion, medio_notificacion, codigo_seguimiento_postal, constancia_recepcion,
          fecha_pago, medio_pago_multa, nro_operacion_pago, cuenta_id_pago, tarjeta_id_pago, cuotas_pago } = req.body;
  const _montoVol = monto_voluntario || monto || null;
  const _fVtoVol  = fecha_vto_voluntario || fecha_vencimiento || null;
  try {
    const db = await getPool();
    await db.query(
      `UPDATE multas SET vehiculo_id=?, chofer_id=?, municipalidad_id=?, fecha_infraccion=?, hora_infraccion=?, numero_acta=?, descripcion=?, articulo_infringido=?, lugar=?, monto=?, monto_voluntario=?, monto_total=?, puntos=?, fecha_vencimiento=?, fecha_vto_voluntario=?, fecha_vto_total=?, url_consulta=?, estado=?, nombre_infractor=?, dni_infractor=?, notas=?,
                         fecha_emision_acta=?, fecha_notificacion=?, medio_notificacion=?, codigo_seguimiento_postal=?, constancia_recepcion=?,
                         fecha_pago=?, medio_pago_multa=?, nro_operacion_pago=?, cuenta_id_pago=?, tarjeta_id_pago=?, cuotas_pago=? WHERE id=?`,
      [vehiculo_id, chofer_id||null, municipalidad_id||null, fecha_infraccion||null, hora_infraccion||null, numero_acta||null, descripcion, articulo_infringido||null, lugar||null,
       _montoVol, _montoVol, monto_total||null,
       puntos||null, _fVtoVol, _fVtoVol, fecha_vto_total||null,
       url_consulta||null, estado||'pendiente', nombre_infractor||null, dni_infractor||null, notas||null,
       fecha_emision_acta||null, fecha_notificacion||null, medio_notificacion||null, codigo_seguimiento_postal||null, constancia_recepcion ? 1 : 0,
       fecha_pago||null, medio_pago_multa||null, nro_operacion_pago||null, cuenta_id_pago||null, tarjeta_id_pago||null, cuotas_pago||null, req.params.id]
    );
    await registrarAuditoria(req, 'multas', 'editar', req.params.id, `Multa actualizada${numero_acta ? ': acta ' + numero_acta : ''} — estado: ${estado||'pendiente'}`);
    res.json({ message: 'Infracción actualizada' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/multas/:id', async (req, res) => {
  if (!await checkPuedeEliminar(req, res)) return;
  try {
    const db = await getPool();
    const [mt] = await db.query('SELECT numero_acta FROM multas WHERE id=?', [req.params.id]);
    await db.query('DELETE FROM multas WHERE id=?', [req.params.id]);
    await registrarAuditoria(req, 'multas', 'eliminar', req.params.id, `Multa eliminada: acta ${mt[0]?.numero_acta||req.params.id}`);
    res.json({ message: 'Infracción eliminada' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Adjuntos de multa — multer se inicializa lazy en el middleware
const path2 = require('path');
let _uploadMultaAdj = null;
function getUploadMultaAdj() {
  if (!_uploadMultaAdj) {
    _uploadMultaAdj = multer({
      storage: multer.diskStorage({
        destination: (req, file, cb) => {
          const dir = path2.join(__dirname, 'public', 'uploads', 'multas', req.params.id);
          require('fs').mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (req, file, cb) => {
          cb(null, `adj_${Date.now()}${path2.extname(file.originalname)}`);
        }
      }),
      fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg','image/png','image/gif','image/webp','application/pdf','video/mp4','video/avi','video/mov','video/quicktime','video/webm','video/x-msvideo'];
        cb(null, allowed.includes(file.mimetype));
      },
      limits: { fileSize: 100 * 1024 * 1024 }
    });
  }
  return _uploadMultaAdj;
}

app.get('/api/multas/:id/adjuntos', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM multa_adjuntos WHERE multa_id=? ORDER BY fecha_subida ASC', [req.params.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Proxy para descargar imágenes externas (links de actas de municipios) — evita CORS en el browser
app.get('/api/proxy-imagen', requireAuth, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ message: 'url requerida' });
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) return res.status(resp.status).json({ message: 'No se pudo descargar la imagen' });
    const ct = resp.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await resp.arrayBuffer());
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'private, max-age=300');
    res.send(buf);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/multas/:id/adjuntos', (req, res, next) => getUploadMultaAdj().array('adjuntos', 20)(req, res, next), async (req, res) => {
  try {
    const db = await getPool();
    for (const file of req.files) {
      const url = `/uploads/multas/${req.params.id}/${file.filename}`;
      const tipo = file.mimetype.startsWith('image/') ? 'imagen' : file.mimetype === 'application/pdf' ? 'pdf' : 'video';
      await db.query('INSERT INTO multa_adjuntos (multa_id, tipo, url, nombre_original) VALUES (?,?,?,?)', [req.params.id, tipo, url, file.originalname]);
    }
    await registrarAuditoria(req, 'multas', 'adjunto-subir', req.params.id, `${req.files.length} adjunto(s) subido(s) a multa ${req.params.id}`);
    res.status(201).json({ message: `${req.files.length} adjunto(s) guardado(s)` });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Comprobante de pago de multa
let _uploadComprobantePago = null;
function getUploadComprobantePago() {
  if (!_uploadComprobantePago) {
    _uploadComprobantePago = multer({
      storage: multer.diskStorage({
        destination: (req, file, cb) => {
          const dir = path2.join(__dirname, 'public', 'uploads', 'multas', req.params.id);
          require('fs').mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (req, file, cb) => { cb(null, `pago_${Date.now()}${path2.extname(file.originalname)}`); }
      }),
      limits: { fileSize: 20 * 1024 * 1024 },
      fileFilter: (req, file, cb) => { cb(null, /image|pdf/.test(file.mimetype)); }
    });
  }
  return _uploadComprobantePago;
}

app.post('/api/multas/:id/comprobante-pago', (req, res, next) => {
  // Si viene JSON con url ya subida, saltear multer
  if (req.is('application/json')) return next();
  getUploadComprobantePago().single('comprobante')(req, res, next);
}, async (req, res) => {
  try {
    const db = await getPool();
    let url;
    if (req.file) {
      url = `/uploads/multas/${req.params.id}/${req.file.filename}`;
    } else if (req.body?.url) {
      url = req.body.url;
    } else {
      return res.status(400).json({ message: 'Archivo o URL requerido' });
    }
    await db.query('UPDATE multas SET comprobante_pago_url=? WHERE id=?', [url, req.params.id]);
    res.json({ url });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/multas/:id/adjuntos/link', async (req, res) => {
  const { url, nombre } = req.body;
  if (!url) return res.status(400).json({ message: 'url requerida' });
  try {
    const db = await getPool();
    await db.query('INSERT INTO multa_adjuntos (multa_id, tipo, url, nombre_original) VALUES (?,?,?,?)', [req.params.id, 'link', url, nombre||url]);
    await registrarAuditoria(req, 'multas', 'adjunto-link', req.params.id, `Link adjuntado a multa ${req.params.id}: ${nombre||url}`);
    res.status(201).json({ message: 'Link guardado' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/multas/:id/adjuntos/:aid', async (req, res) => {
  try {
    const db = await getPool();
    const [[adj]] = await db.query('SELECT * FROM multa_adjuntos WHERE id=?', [req.params.aid]);
    if (adj && adj.tipo !== 'link') {
      const fs = require('fs');
      const fp = path2.join(__dirname, 'public', adj.url);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    await db.query('DELETE FROM multa_adjuntos WHERE id=?', [req.params.aid]);
    await registrarAuditoria(req, 'multas', 'adjunto-eliminar', req.params.id, `Adjunto eliminado de multa ${req.params.id} (adj_id=${req.params.aid})`);
    res.json({ message: 'Adjunto eliminado' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Municipalidades
app.get('/api/municipalidades', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM municipalidades ORDER BY nombre ASC');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/municipalidades', async (req, res) => {
  const { nombre, jurisdiccion, provincia, url_consulta, url_pago, email_contacto, telefono, notas } = req.body;
  if (!nombre) return res.status(400).json({ message: 'Nombre requerido' });
  try {
    const db = await getPool();
    const [r] = await db.query(
      `INSERT INTO municipalidades (nombre, jurisdiccion, provincia, url_consulta, url_pago, email_contacto, telefono, notas) VALUES (?,?,?,?,?,?,?,?)`,
      [nombre, jurisdiccion||'OTRO', provincia||null, url_consulta||null, url_pago||null, email_contacto||null, telefono||null, notas||null]
    );
    await registrarAuditoria(req, 'municipalidades', 'crear', r.insertId, `Nueva municipalidad: ${nombre}`);
    res.status(201).json({ message: 'Municipalidad registrada', id: r.insertId });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put('/api/municipalidades/:id', async (req, res) => {
  const { nombre, jurisdiccion, provincia, url_consulta, url_pago, email_contacto, telefono, notas, activa } = req.body;
  try {
    const db = await getPool();
    await db.query(
      `UPDATE municipalidades SET nombre=?, jurisdiccion=?, provincia=?, url_consulta=?, url_pago=?, email_contacto=?, telefono=?, notas=?, activa=? WHERE id=?`,
      [nombre, jurisdiccion||'OTRO', provincia||null, url_consulta||null, url_pago||null, email_contacto||null, telefono||null, notas||null, activa!==undefined?activa:1, req.params.id]
    );
    await registrarAuditoria(req, 'municipalidades', 'editar', req.params.id, `Municipalidad actualizada: ${nombre}`);
    res.json({ message: 'Municipalidad actualizada' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/municipalidades/:id', async (req, res) => {
  if (!await checkPuedeEliminar(req, res)) return;
  try {
    const db = await getPool();
    const [mn] = await db.query('SELECT nombre FROM municipalidades WHERE id=?', [req.params.id]);
    await db.query('DELETE FROM municipalidades WHERE id=?', [req.params.id]);
    await registrarAuditoria(req, 'municipalidades', 'eliminar', req.params.id, `Municipalidad eliminada: ${mn[0]?.nombre||req.params.id}`);
    res.json({ message: 'Municipalidad eliminada' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Verificación automática de multas por patente (Puppeteer) ──────────────
const scraper = require('./scraper');
const { v4: uuidv4 } = require('uuid');

// Auditoría de verificaciones
app.post('/api/verificacion/log', async (req, res) => {
  try {
    const db = await getPool();
    const { vehiculo_id, municipalidad_id, resultado, multas_encontradas, multas_importadas, usuario } = req.body;
    await db.query(
      `INSERT INTO multa_verificacion_log (vehiculo_id, municipalidad_id, resultado, multas_encontradas, multas_importadas, usuario)
       VALUES (?,?,?,?,?,?)`,
      [vehiculo_id, municipalidad_id, resultado || 'sin_multas', multas_encontradas || 0, multas_importadas || 0, usuario || null]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/verificacion/log/:vehiculoId/:municipalidadId', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query(
      `SELECT l.*, v.patente FROM multa_verificacion_log l
       JOIN vehiculos v ON v.id = l.vehiculo_id
       WHERE l.vehiculo_id=? AND l.municipalidad_id=?
       ORDER BY l.fecha DESC LIMIT 10`,
      [req.params.vehiculoId, req.params.municipalidadId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/verificacion/log/ultimo/:vehiculoId/:municipalidadId', async (req, res) => {
  try {
    const db = await getPool();
    const [[row]] = await db.query(
      `SELECT l.fecha, l.resultado, l.multas_encontradas, l.multas_importadas, l.usuario
       FROM multa_verificacion_log l
       WHERE l.vehiculo_id=? AND l.municipalidad_id=?
       ORDER BY l.fecha DESC LIMIT 1`,
      [req.params.vehiculoId, req.params.municipalidadId]
    );
    res.json(row || null);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Iniciar verificación: abre navegador, llena la patente
app.post('/api/verificacion/iniciar', async (req, res) => {
  try {
    const { municipalidad_id, vehiculo_id } = req.body;
    if (!municipalidad_id || !vehiculo_id) return res.status(400).json({ message: 'municipalidad_id y vehiculo_id requeridos' });
    const db = await getPool();
    const [[muni]] = await db.query('SELECT * FROM municipalidades WHERE id=?', [municipalidad_id]);
    const [[veh]] = await db.query('SELECT * FROM vehiculos WHERE id=?', [vehiculo_id]);
    if (!muni) return res.status(404).json({ message: 'Municipalidad no encontrada' });
    if (!veh)  return res.status(404).json({ message: 'Vehículo no encontrado' });
    if (!muni.url_consulta) return res.status(400).json({ message: 'Esta municipalidad no tiene URL de consulta configurada' });

    const { modo } = req.body; // 'auto' | 'manual' | undefined (auto-detect)
    const jobId = uuidv4();
    await scraper.iniciarVerificacion(jobId, muni.url_consulta, veh.patente, modo);
    res.json({ jobId, url: muni.url_consulta, patente: veh.patente });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Stream SSE de estado del job
app.get('/api/verificacion/:jobId/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const { jobId } = req.params;
  const ok = scraper.addSseClient(jobId, res);
  if (!ok) { res.write(`data: ${JSON.stringify({ status: 'error', msg: 'Job no encontrado' })}\n\n`); res.end(); return; }

  req.on('close', () => scraper.removeSseClient(jobId, res));
});

// Extraer resultados de la página actual
app.post('/api/verificacion/:jobId/extraer', async (req, res) => {
  try {
    const result = await scraper.extraerResultados(req.params.jobId);
    res.json(result);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Importar multas encontradas a la DB (con adjuntos de prueba)
app.post('/api/verificacion/:jobId/importar', async (req, res) => {
  try {
    const { multas, vehiculo_id, municipalidad_id } = req.body;
    if (!multas?.length) return res.json({ importadas: 0 });
    const db = await getPool();
    let importadas = 0;
    const ids = [];
    for (const m of multas) {
      // Evitar duplicados por número de acta
      if (m.numero_acta) {
        const [[dup]] = await db.query('SELECT id FROM multas WHERE numero_acta=? AND vehiculo_id=?', [m.numero_acta, vehiculo_id]);
        if (dup) continue;
      }
      const estadoMap = { pagada: 'pagada', vencida: 'vencida', pendiente: 'pendiente' };
      const estado = estadoMap[m.estado?.toLowerCase()] || 'pendiente';
      // Separar datetime-local ("2022-08-06T11:43") en fecha y hora individuales
      let fechaInfraccion = m.fecha_infraccion || null;
      let horaInfraccion  = m.hora_infraccion  || null;
      if (fechaInfraccion && fechaInfraccion.includes('T')) {
        const [datePart, timePart] = fechaInfraccion.split('T');
        fechaInfraccion = datePart;
        if (!horaInfraccion && timePart) horaInfraccion = timePart.length === 5 ? timePart + ':00' : timePart;
      }
      const [r] = await db.query(
        `INSERT INTO multas (vehiculo_id, municipalidad_id, numero_acta, fecha_infraccion, hora_infraccion, fecha_vencimiento, descripcion, articulo_infringido, lugar, monto, puntos, estado, nombre_infractor, notas)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [vehiculo_id, municipalidad_id||null, m.numero_acta||null, fechaInfraccion, horaInfraccion,
         m.fecha_vencimiento||null, m.descripcion||'Infracción importada', m.articulo_infringido||null,
         m.lugar||null, m.monto||null, m.puntos||null, estado, m.nombre_infractor||null,
         `Importada automáticamente${m.organismo ? ' — ' + m.organismo : ''}`]
      );
      const multaId = r.insertId;

      // Descargar y guardar pruebas localmente
      if (m.prueba_urls?.length) {
        const uploadDir = path.join(__dirname, 'public', 'uploads', 'multas', String(multaId));
        fs.mkdirSync(uploadDir, { recursive: true });
        for (let pi = 0; pi < m.prueba_urls.length; pi++) {
          const url = m.prueba_urls[pi];
          if (!url || typeof url !== 'string') continue;
          const isVid = /\.(mp4|avi|mov|webm|mkv)/i.test(url);
          let localUrl = null, tipo = 'link';
          try {
            const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
            if (resp.ok) {
              const ct = resp.headers.get('content-type') || '';
              const ext = ct.includes('video') ? 'mp4'
                        : ct.includes('png')  ? 'png'
                        : ct.includes('gif')  ? 'gif'
                        : ct.includes('webp') ? 'webp'
                        : 'jpg';
              tipo = ct.includes('video') || isVid ? 'video' : 'imagen';
              const fname = `prueba_${pi + 1}_${Date.now()}.${ext}`;
              const buf = Buffer.from(await resp.arrayBuffer());
              fs.writeFileSync(path.join(uploadDir, fname), buf);
              localUrl = `/uploads/multas/${multaId}/${fname}`;
            }
          } catch (_) {}
          // Si no se pudo descargar, guardar el link original como fallback
          await db.query(
            'INSERT INTO multa_adjuntos (multa_id, tipo, url, nombre_original) VALUES (?,?,?,?)',
            [multaId, localUrl ? tipo : 'link', localUrl || url, `Prueba ${m.numero_acta || ''} #${pi + 1}`]
          ).catch(() => {});
        }
      }

      importadas++;
      ids.push({ numero_acta: m.numero_acta || null, id: multaId });
    }
    res.json({ importadas, ids });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Cancelar/cerrar job
app.delete('/api/verificacion/:jobId', async (req, res) => {
  await scraper.cancelarJob(req.params.jobId);
  res.json({ message: 'Job cancelado' });
});

// (extract-factura endpoint registrado más abajo junto con memUpload)

// (GET /api/bancos registrado más arriba junto con POST/PUT/DELETE)

// 10. Préstamos (GET, POST, PUT, DELETE)
// ── PRÉSTAMOS ────────────────────────────────────────────────────────────────
// Rutas específicas primero (antes de /:id) para evitar colisión de Express

app.put('/api/prestamos/cuotas/:cuota_id/pagar', async (req, res) => {
  try {
    const db = await getPool();
    const [[cq]] = await db.query('SELECT nro_cuota, prestamo_id FROM prestamos_cuotas WHERE id=?', [req.params.cuota_id]);
    await db.query(
      'UPDATE prestamos_cuotas SET pagada=1, fecha_pago=CURDATE() WHERE id=?',
      [req.params.cuota_id]);
    await registrarAuditoria(req, 'prestamos', 'cuota-pagar', cq?.prestamo_id||null, `Cuota #${cq?.nro_cuota||req.params.cuota_id} marcada como pagada`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/prestamos/cuotas/:cuota_id', async (req, res) => {
  if (!await checkPuedeEliminar(req, res)) return;
  try {
    const db = await getPool();
    const [[cq2]] = await db.query('SELECT nro_cuota, prestamo_id FROM prestamos_cuotas WHERE id=?', [req.params.cuota_id]);
    await db.query('DELETE FROM prestamos_cuotas WHERE id=?', [req.params.cuota_id]);
    await registrarAuditoria(req, 'prestamos', 'cuota-eliminar', cq2?.prestamo_id||null, `Cuota #${cq2?.nro_cuota||req.params.cuota_id} eliminada`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── CashFlow: pivot de vencimientos por banco dentro de un período ────────────
app.get('/api/prestamos/cashflow', async (req, res) => {
  try {
    const db = await getPool();
    const { desde, hasta } = req.query;
    if (!desde || !hasta) return res.status(400).json({ message: 'desde y hasta son obligatorios' });

    // UNION de tabla vieja (prestamo_cuotas) + nueva (prestamos_cuotas)
    // La tabla vieja usa monto_cuota/fecha_pago/estado; la nueva usa importe/fecha/pagada
    const _cuotasSrc = `(
      SELECT prestamo_id, fecha_pago AS fecha, monto_cuota AS importe,
             CASE WHEN estado='pagado' THEN 1 ELSE 0 END AS pagada
      FROM prestamo_cuotas WHERE fecha_pago IS NOT NULL
      UNION ALL
      SELECT prestamo_id, fecha, importe, pagada FROM prestamos_cuotas
    ) c`;
    const _joinBanco = `
      JOIN prestamos p ON p.id = c.prestamo_id
      LEFT JOIN bancos   b  ON b.id  = p.banco_id
      LEFT JOIN cuentas  ct ON ct.id = p.cuenta_id
      LEFT JOIN bancos   bc ON bc.id = ct.banco_id`;
    const _whereBase = `c.pagada = 0 AND p.estado NOT IN ('pagado','cancelado')`;

    // Cuotas NO pagadas dentro del período
    const [dentro] = await db.query(`
      SELECT c.fecha, c.importe,
        COALESCE(b.nombre, bc.nombre, 'Sin banco') AS banco_nombre
      FROM ${_cuotasSrc} ${_joinBanco}
      WHERE ${_whereBase} AND c.fecha BETWEEN ? AND ?
    `, [desde, hasta]);

    // Cuotas fuera del período (antes + después) → saldo pendiente proyectado (Resto)
    const [despues] = await db.query(`
      SELECT COALESCE(b.nombre, bc.nombre, 'Sin banco') AS banco_nombre,
        SUM(c.importe) AS resto
      FROM ${_cuotasSrc} ${_joinBanco}
      WHERE ${_whereBase} AND (c.fecha < ? OR c.fecha > ?)
      GROUP BY banco_nombre
    `, [desde, hasta]);

    // Fechas únicas dentro del período (columnas)
    const fechasSet = [...new Set(dentro.map(r => r.fecha instanceof Date
      ? r.fecha.toISOString().slice(0, 10)
      : String(r.fecha).slice(0, 10)))].sort();

    // Bancos únicos
    const bancosSet = new Set([...dentro, ...despues].map(r => r.banco_nombre));
    const bancos = [...bancosSet].sort();

    // Construir pivot: banco → fecha → suma
    const pivot = {};
    bancos.forEach(b => {
      pivot[b] = {};
      fechasSet.forEach(f => { pivot[b][f] = 0; });
      pivot[b].__resto = 0;
    });
    dentro.forEach(r => {
      const f = r.fecha instanceof Date ? r.fecha.toISOString().slice(0,10) : String(r.fecha).slice(0,10);
      if (!pivot[r.banco_nombre]) { pivot[r.banco_nombre] = {}; fechasSet.forEach(f2 => { pivot[r.banco_nombre][f2] = 0; }); pivot[r.banco_nombre].__resto = 0; }
      pivot[r.banco_nombre][f] = (pivot[r.banco_nombre][f] || 0) + parseFloat(r.importe);
    });
    despues.forEach(r => { if (pivot[r.banco_nombre]) pivot[r.banco_nombre].__resto = parseFloat(r.resto || 0); });

    // Totales por columna
    const totales = {};
    fechasSet.forEach(f => { totales[f] = bancos.reduce((s, b) => s + (pivot[b][f] || 0), 0); });
    totales.__resto = bancos.reduce((s, b) => s + (pivot[b].__resto || 0), 0);

    await registrarAuditoria(req, 'prestamos', 'ver', null, `CashFlow ${desde} → ${hasta}`);
    res.json({ fechas: fechasSet, bancos, pivot, totales });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/prestamos', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query(`
      SELECT
        pr.*,
        COALESCE(b.nombre,  bc.nombre)      AS banco_nombre,
        COALESCE(b.logo_emoji, bc.logo_emoji) AS banco_emoji,
        c.alias    AS cuenta_alias, c.nombre AS cuenta_nombre, c.apellido AS cuenta_apellido, c.dni AS cuenta_dni,
        pc.nombre  AS cp_nombre,    pc.apellido AS cp_apellido, pc.dni AS cp_dni,
        v.patente  AS vehiculo_patente,
        pv.nombre  AS vp_nombre,   pv.apellido AS vp_apellido, pv.dni AS vp_dni,
        uc.nombre  AS created_by_nombre,
        uu.nombre  AS updated_by_nombre,
        (SELECT COUNT(*) FROM prestamos_cuotas pc2 WHERE pc2.prestamo_id = pr.id)  AS total_cuotas,
        (SELECT COALESCE(SUM(pc2.importe),0) FROM prestamos_cuotas pc2 WHERE pc2.prestamo_id = pr.id) AS total_importe,
        (SELECT COALESCE(SUM(pc2.importe),0) FROM prestamos_cuotas pc2 WHERE pc2.prestamo_id = pr.id AND pc2.pagada = 1) AS total_pagado
      FROM prestamos pr
      LEFT JOIN bancos    b  ON pr.banco_id    = b.id
      LEFT JOIN cuentas   c  ON pr.cuenta_id   = c.id
      LEFT JOIN bancos    bc ON c.banco_id      = bc.id
      LEFT JOIN personas  pc ON c.persona_id   = pc.id
      LEFT JOIN vehiculos v  ON pr.vehiculo_id  = v.id
      LEFT JOIN personas  pv ON v.persona_id   = pv.id
      LEFT JOIN usuarios  uc ON pr.created_by  = uc.id
      LEFT JOIN usuarios  uu ON pr.updated_by  = uu.id
      ORDER BY pr.fecha_inicio DESC, pr.id DESC
    `);
    // persona efectiva = persona de cuenta ó persona de vehículo (en ese orden)
    const mapped = rows.map(r => ({
      ...r,
      persona_nombre:   r.cp_nombre   || r.vp_nombre   || r.nombre_prestatario || null,
      persona_apellido: r.cp_apellido || r.vp_apellido || null,
      persona_dni:      r.cp_dni      || r.vp_dni      || r.cuenta_dni         || null,
    }));
    res.json(mapped);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/prestamos/:id', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query(`
      SELECT pr.*,
        c.alias AS cuenta_alias, c.nombre AS cuenta_nombre, c.apellido AS cuenta_apellido,
        pc.nombre AS cp_nombre, pc.apellido AS cp_apellido, pc.dni AS cp_dni,
        v.patente AS vehiculo_patente,
        pv.nombre AS vp_nombre, pv.apellido AS vp_apellido
      FROM prestamos pr
      LEFT JOIN cuentas  c  ON pr.cuenta_id  = c.id
      LEFT JOIN personas pc ON c.persona_id  = pc.id
      LEFT JOIN vehiculos v ON pr.vehiculo_id = v.id
      LEFT JOIN personas pv ON v.persona_id  = pv.id
      WHERE pr.id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'No encontrado' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/prestamos/:id/cuotas', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query(
      'SELECT * FROM prestamos_cuotas WHERE prestamo_id=? ORDER BY nro_cuota ASC',
      [req.params.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/prestamos', async (req, res) => {
  const { cuenta_id, vehiculo_id, capital, tasa, tipo_amortizacion, plazo_meses, fecha_inicio, estado, descripcion,
          nombre_prestatario, monto, fecha_prestamo, tipo_prestamo } = req.body;
  const capVal = capital || monto;
  if (!capVal) return res.status(400).json({ message: 'Capital es requerido' });
  try {
    const db = await getPool();
    const userId = req.session?.usuario?.id || null;
    const [r] = await db.query(`
      INSERT INTO prestamos
        (cuenta_id, vehiculo_id, capital, tasa, tipo_amortizacion, plazo_meses, fecha_inicio, estado, descripcion,
         nombre_prestatario, monto, fecha_prestamo, tipo_prestamo, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cuenta_id||null, vehiculo_id||null, capVal, tasa||null, tipo_amortizacion||null, plazo_meses||null,
       fecha_inicio||null, estado||'activo', descripcion||null,
       nombre_prestatario||null, capVal, fecha_inicio||null, tipo_amortizacion||tipo_prestamo||'Francés',
       userId]);
    await registrarAuditoria(req, 'prestamos', 'crear', r.insertId, `Préstamo #${r.insertId} — ${nombre_prestatario||descripcion||'?'} · $${Number(capVal).toLocaleString('es-AR',{minimumFractionDigits:2})} · ${fecha_inicio||fecha_prestamo||''}`);
    res.status(201).json({ id: r.insertId });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put('/api/prestamos/:id', async (req, res) => {
  const { cuenta_id, vehiculo_id, capital, tasa, tipo_amortizacion, plazo_meses, fecha_inicio, estado, descripcion } = req.body;
  if (!capital) return res.status(400).json({ message: 'Capital es requerido' });
  try {
    const db = await getPool();
    const userId = req.session?.usuario?.id || null;
    await db.query(`
      UPDATE prestamos SET
        cuenta_id=?, vehiculo_id=?, capital=?, tasa=?, tipo_amortizacion=?,
        plazo_meses=?, fecha_inicio=?, estado=?, descripcion=?,
        monto=?, tipo_prestamo=?, updated_by=?
      WHERE id=?`,
      [cuenta_id||null, vehiculo_id||null, capital, tasa||null, tipo_amortizacion||null,
       plazo_meses||null, fecha_inicio||null, estado||'activo', descripcion||null,
       capital, tipo_amortizacion||null, userId, req.params.id]);
    await registrarAuditoria(req, 'prestamos', 'editar', req.params.id, `Préstamo editado`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/prestamos/:id', async (req, res) => {
  if (!await checkPuedeEliminar(req, res)) return;
  try {
    const db = await getPool();
    await db.query('DELETE FROM prestamos WHERE id=?', [req.params.id]);
    await registrarAuditoria(req, 'prestamos', 'eliminar', req.params.id, 'Préstamo eliminado');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Cuotas: pegar en bloque (reemplaza todas)
app.post('/api/prestamos/:id/cuotas/bulk', async (req, res) => {
  const { cuotas } = req.body; // [{nro_cuota, fecha, importe}]
  if (!Array.isArray(cuotas) || !cuotas.length)
    return res.status(400).json({ message: 'Sin cuotas para guardar' });
  try {
    const db = await getPool();
    await db.query('DELETE FROM prestamos_cuotas WHERE prestamo_id=?', [req.params.id]);
    const vals = cuotas.map(c => [req.params.id, c.nro_cuota, c.fecha, c.importe]);
    await db.query(
      'INSERT INTO prestamos_cuotas (prestamo_id,nro_cuota,fecha,importe) VALUES ?', [vals]);
    await registrarAuditoria(req, 'prestamos', 'cuotas-bulk', req.params.id,
      `${cuotas.length} cuotas cargadas`);
    res.json({ ok: true, count: cuotas.length });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Cuotas agrupadas por mes (para gráfico)
app.get('/api/prestamos/cuotas/por-mes', async (req, res) => {
  const { year, persona_id, estado, desde, hasta } = req.query;
  try {
    const db = await getPool();
    let where = [];
    const params = [];
    if (year)       { where.push('YEAR(pc.fecha) = ?'); params.push(year); }
    if (desde)      { where.push('pc.fecha >= ?'); params.push(desde); }
    if (hasta)      { where.push('pc.fecha <= ?'); params.push(hasta); }
    if (persona_id) { where.push('(c.persona_id = ? OR v.persona_id = ?)'); params.push(persona_id, persona_id); }
    if (estado)     { where.push('pr.estado = ?'); params.push(estado); }
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [rows] = await db.query(`
      SELECT
        DATE_FORMAT(pc.fecha, '%Y-%m') AS mes,
        SUM(pc.importe)                AS total,
        SUM(CASE WHEN pc.pagada=1 THEN pc.importe ELSE 0 END) AS pagado,
        SUM(CASE WHEN pc.pagada=0 THEN pc.importe ELSE 0 END) AS pendiente,
        COUNT(*)                       AS cant_cuotas
      FROM prestamos_cuotas pc
      JOIN prestamos pr ON pc.prestamo_id = pr.id
      LEFT JOIN cuentas  c ON pr.cuenta_id  = c.id
      LEFT JOIN vehiculos v ON pr.vehiculo_id = v.id
      ${whereStr}
      GROUP BY mes ORDER BY mes ASC
    `, params);
    // Años disponibles
    const [years] = await db.query(`
      SELECT DISTINCT YEAR(pc.fecha) AS y FROM prestamos_cuotas pc ORDER BY y DESC
    `);
    // Personas disponibles
    const [personas] = await db.query(`
      SELECT DISTINCT p.id, p.apellido, p.nombre
      FROM personas p
      WHERE p.id IN (
        SELECT c2.persona_id FROM cuentas c2 JOIN prestamos pr2 ON pr2.cuenta_id=c2.id WHERE c2.persona_id IS NOT NULL
        UNION
        SELECT v2.persona_id FROM vehiculos v2 JOIN prestamos pr2 ON pr2.vehiculo_id=v2.id WHERE v2.persona_id IS NOT NULL
      )
      ORDER BY p.apellido, p.nombre
    `);
    res.json({ rows, years: years.map(r=>r.y), personas });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// 11. Pagos / Operaciones Financieras (GET, POST)

// Check de duplicado por nro_transaccion
app.get('/api/pagos/check-dup', async (req, res) => {
  const { nro_transaccion, chofer_id, exclude_id } = req.query;
  if (!nro_transaccion) return res.json({ existe: false });
  try {
    const db = await getPool();
    const params = [nro_transaccion];
    let sql = `SELECT id, fecha FROM pagos WHERE nro_transaccion = ?`;
    if (exclude_id) { sql += ` AND id != ?`; params.push(parseInt(exclude_id, 10)); }
    sql += ` LIMIT 1`;
    const [rows] = await db.query(sql, params);
    if (rows.length) res.json({ existe: true, fecha: rows[0].fecha, id: rows[0].id });
    else res.json({ existe: false });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/debug/pagos-cols', async (req, res) => {
  const db = await getPool();
  const [rows] = await db.query('DESCRIBE pagos');
  res.json({ cols: rows.map(r => r.Field), version: 'DESCRIBE-INSERT-v2' });
});

app.get('/api/pagos', async (req, res) => {
  try {
    const db = await getPool();
    const { tipo, desde, hasta, chofer_id, cuenta_id } = req.query;
    const conditions = [];
    const params = [];
    if (tipo)      { conditions.push('pg.tipo = ?');        params.push(tipo); }
    if (desde)     { conditions.push('pg.fecha >= ?');      params.push(desde); }
    if (hasta)     { conditions.push('pg.fecha <= ?');      params.push(hasta + ' 23:59:59'); }
    if (chofer_id) { conditions.push('pg.chofer_id = ?');   params.push(chofer_id); }
    if (cuenta_id) { conditions.push('pg.cuenta_id = ?');   params.push(cuenta_id); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const [rows] = await db.query(`
      SELECT pg.*, c.nombre as chofer_nombre, cu.alias as cuenta_alias
      FROM pagos pg
      LEFT JOIN choferes c ON pg.chofer_id = c.id
      LEFT JOIN cuentas cu ON pg.cuenta_id = cu.id
      ${where}
      ORDER BY pg.fecha DESC
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/pagos', upload.single('comprobante'), async (req, res) => {
  // FormData con campos duplicados llega como array — normalizamos a string
  const _s = (v) => Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
  const chofer_id            = _s(req.body.chofer_id);
  const cuenta_id            = _s(req.body.cuenta_id);
  const monto                = _s(req.body.monto);
  const tipo                 = _s(req.body.tipo);
  const concepto             = _s(req.body.concepto);
  const fecha                = _s(req.body.fecha);
  const medio_pago           = _s(req.body.medio_pago);
  const detalle              = _s(req.body.detalle);
  const alias_destino        = _s(req.body.alias_destino);
  const nro_transaccion      = _s(req.body.nro_transaccion);
  const codigo_identificacion= _s(req.body.codigo_identificacion);
  const origen_nombre        = _s(req.body.origen_nombre);
  const origen_cuil          = _s(req.body.origen_cuil);
  const origen_cbu           = _s(req.body.origen_cbu);
  const origen_alias         = _s(req.body.origen_alias);
  const origen_banco         = _s(req.body.origen_banco);
  const destino_nombre       = _s(req.body.destino_nombre);
  const destino_cuil         = _s(req.body.destino_cuil);
  const destino_cbu          = _s(req.body.destino_cbu);
  const destino_alias        = _s(req.body.destino_alias);
  const destino_banco        = _s(req.body.destino_banco);
  if (!chofer_id) return res.status(400).json({ message: 'El Chofer es obligatorio' });
  if (!monto || !tipo || !concepto || !fecha) return res.status(400).json({ message: 'Monto, tipo, concepto y fecha son obligatorios' });
  try {
    let comprobante_url = null;
    if (req.file) comprobante_url = `/uploads/${req.file.filename}`;
    const db = await getPool();
    // INSERT solo con columnas core (siempre presentes), luego UPDATE para las opcionales
    const [_r] = await db.query(
      'INSERT INTO pagos (chofer_id,cuenta_id,monto,tipo,concepto,fecha,medio_pago,detalle) VALUES (?,?,?,?,?,?,?,?)',
      [chofer_id||null, cuenta_id||null, monto||null, tipo||null, concepto||null, fecha||null, medio_pago||null, detalle||null]
    );
    const pagoId = _r.insertId;
    // UPDATE de columnas opcionales (silencioso si la columna no existe)
    const _optPairs = [
      ['comprobante_url', comprobante_url], ['alias_destino', alias_destino],
      ['nro_transaccion', nro_transaccion], ['codigo_identificacion', codigo_identificacion],
      ['origen_nombre', origen_nombre], ['origen_cuil', origen_cuil],
      ['origen_cbu', origen_cbu], ['origen_alias', origen_alias], ['origen_banco', origen_banco],
      ['destino_nombre', destino_nombre], ['destino_cuil', destino_cuil],
      ['destino_cbu', destino_cbu], ['destino_alias', destino_alias], ['destino_banco', destino_banco],
    ].filter(([, v]) => v != null && v !== '');
    if (_optPairs.length) {
      const [_desc] = await db.query('DESCRIBE pagos');
      const _existing = new Set(_desc.map(r => r.Field));
      const _upd = _optPairs.filter(([c]) => _existing.has(c));
      if (_upd.length) {
        await db.query(
          `UPDATE pagos SET ${_upd.map(([c]) => `${c}=?`).join(',')} WHERE id=?`,
          [..._upd.map(([,v]) => v), pagoId]
        );
      }
    }
    await registrarAuditoria(req, 'pagos', 'crear', pagoId, `Cobro registrado: chofer_id=${chofer_id}, $${monto}, ${concepto}, ${fecha}`);
    // Guardar conceptos si vienen (JSON body → ya parseado; FormData → string)
    if (req.body.conceptos) {
      let conceptos = req.body.conceptos;
      if (typeof conceptos === 'string') { try { conceptos = JSON.parse(conceptos); } catch(_) { conceptos = []; } }
      if (Array.isArray(conceptos)) {
        for (const c of conceptos) {
          if (c.monto > 0) await db.query('INSERT INTO pago_conceptos (pago_id,concepto,monto) VALUES (?,?,?)', [pagoId, c.concepto, c.monto]);
        }
      }
    }
    res.status(201).json({ id: pagoId, message: 'Pago registrado con éxito' });
  } catch (err) {
    console.error('[POST /api/pagos] ERR:', err.code, '|', err.sqlMessage || err.message, '| sql:', err.sql?.slice(0, 300));
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/pagos/:id', async (req, res) => {
  try {
    const db = await getPool();
    const [[pago]] = await db.query(`
      SELECT pg.*, c.nombre as chofer_nombre, c.modalidad as chofer_modalidad, cu.alias as cuenta_alias
      FROM pagos pg
      LEFT JOIN choferes c ON pg.chofer_id = c.id
      LEFT JOIN cuentas cu ON pg.cuenta_id = cu.id
      WHERE pg.id = ?
    `, [req.params.id]);
    if (!pago) return res.status(404).json({ message: 'No encontrado' });
    const [conceptos] = await db.query('SELECT * FROM pago_conceptos WHERE pago_id=?', [req.params.id]);
    res.json({ ...pago, conceptos });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put('/api/pagos/:id', upload.single('comprobante'), requireAuth, async (req, res) => {
  if (req.session?.usuario?.rol !== 'superadmin') return res.status(403).json({ message: 'Solo superadmin puede editar' });
  const _sa = v => Array.isArray(v) ? v[0] : v;
  const chofer_id      = _sa(req.body.chofer_id);
  const cuenta_id      = _sa(req.body.cuenta_id);
  const monto          = _sa(req.body.monto);
  const tipo           = _sa(req.body.tipo);
  const concepto       = _sa(req.body.concepto);
  const fecha          = _sa(req.body.fecha);
  const medio_pago     = _sa(req.body.medio_pago);
  const detalle        = _sa(req.body.detalle);
  const alias_destino  = _sa(req.body.alias_destino);
  const nro_transaccion = _sa(req.body.nro_transaccion);
  if (!chofer_id || !monto || !tipo || !concepto || !fecha)
    return res.status(400).json({ message: 'Campos obligatorios faltantes' });
  try {
    const db = await getPool();
    let comprobante_url;
    if (req.file) {
      comprobante_url = `/uploads/${req.file.filename}`;
    }
    const sets = [
      'chofer_id=?','cuenta_id=?','monto=?','tipo=?','concepto=?','fecha=?',
      'medio_pago=?','detalle=?','alias_destino=?','nro_transaccion=?'
    ];
    const vals = [chofer_id, cuenta_id||null, monto, tipo, concepto, fecha,
                  medio_pago||null, detalle||null, alias_destino||null, nro_transaccion||null];
    if (comprobante_url) { sets.push('comprobante_url=?'); vals.push(comprobante_url); }
    vals.push(req.params.id);
    await db.query(`UPDATE pagos SET ${sets.join(',')} WHERE id=?`, vals);
    // Reemplazar conceptos
    if (req.body.conceptos) {
      let conceptos = req.body.conceptos;
      if (typeof conceptos === 'string') { try { conceptos = JSON.parse(conceptos); } catch(_) { conceptos = []; } }
      if (Array.isArray(conceptos)) {
        await db.query('DELETE FROM pago_conceptos WHERE pago_id=?', [req.params.id]);
        for (const c of conceptos) {
          if (c.monto > 0) await db.query('INSERT INTO pago_conceptos (pago_id,concepto,monto) VALUES (?,?,?)', [req.params.id, c.concepto, c.monto]);
        }
      }
    }
    await registrarAuditoria(req, 'pagos', 'editar', req.params.id, `Cobro editado: $${monto}`);
    res.json({ message: 'Cobro actualizado' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/pagos/:id/conceptos', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM pago_conceptos WHERE pago_id=?', [req.params.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/pagos/:id/conceptos', async (req, res) => {
  try {
    const db = await getPool();
    const conceptos = req.body;
    if (!Array.isArray(conceptos)) return res.status(400).json({ message: 'Se esperaba un array' });
    await db.query('DELETE FROM pago_conceptos WHERE pago_id=?', [req.params.id]);
    for (const c of conceptos) {
      if (c.monto > 0) await db.query('INSERT INTO pago_conceptos (pago_id,concepto,monto) VALUES (?,?,?)', [req.params.id, c.concepto, c.monto]);
    }
    res.json({ message: 'Conceptos guardados' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// --- ENDPOINTS PARA VTV, GNC Y SEGUROS ---
const Tesseract = require('tesseract.js');
let sharp; try { sharp = require('sharp'); } catch(_) { sharp = null; }

// Preprocesa imagen para OCR: grayscale → normalize → sharpen → escala 2400px
// Devuelve ruta del archivo preprocesado (borrar después de OCR si difiere del original)
async function preprocessForOCR(inputPath) {
  if (!sharp) return inputPath;
  const outPath = inputPath + '_pre.png';
  try {
    const meta = await sharp(inputPath).metadata();
    const targetW = Math.max(meta.width || 0, 2400);
    // Pipeline base: escala de grises + contraste + nitidez
    const base = sharp(inputPath)
      .rotate()                                        // auto-rotar según EXIF
      .resize({ width: targetW, withoutEnlargement: false })
      .grayscale()
      .normalize()
      .sharpen({ sigma: 1.5, m1: 0.5, m2: 3 });
    // Guardar versión con binarización
    await base.clone().threshold(145).png().toFile(outPath);
    return outPath;
  } catch (e) {
    console.warn('[OCR-PREPROCESS] Error:', e.message);
    return inputPath;
  }
}

// OCR con preprocesado y fallback a imagen original si el preprocesado da menos texto
async function ocrWithFallback(filePath, langs = 'spa+eng') {
  const opts = { tessedit_pageseg_mode: '4', tessedit_ocr_engine_mode: '1', preserve_interword_spaces: '1' };
  const prePath = await preprocessForOCR(filePath);
  const { data: { text: preText } } = await Tesseract.recognize(prePath, langs, opts);
  if (prePath !== filePath) try { fs.unlinkSync(prePath); } catch(_) {}
  // Si el preprocesado dio muy poco texto, intentar con la imagen original también
  if (preText.replace(/\s/g,'').length < 50) {
    const { data: { text: rawText } } = await Tesseract.recognize(filePath, langs, opts);
    return preText.length >= rawText.length ? preText : rawText;
  }
  return preText;
}

// 0. Generic File Upload (POST)
app.post('/api/upload', upload.single('archivo'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No se subió ningún archivo' });
  }
  res.json({
    success: true,
    archivo_url: `/uploads/${req.file.filename}`,
    original_name: req.file.originalname
  });
});


// 1. Catálogo de Aseguradoras (GET)
// ── CRUD Aseguradoras ────────────────────────────────────────────────────────
app.get('/api/aseguradoras', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM aseguradoras ORDER BY nombre ASC');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/aseguradoras/:id', async (req, res) => {
  try {
    const db = await getPool();
    const [[row]] = await db.query('SELECT * FROM aseguradoras WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ message: 'No encontrada' });
    const [contactos] = await db.query('SELECT * FROM aseguradoras_contactos WHERE aseguradora_id=? ORDER BY nombre ASC', [req.params.id]);
    res.json({ ...row, contactos });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put('/api/aseguradoras/:id', async (req, res) => {
  const { nombre, cuit, web, domicilio, entre_calles, codigo_postal, lat, lng, telefono, email, notas } = req.body;
  if (!nombre) return res.status(400).json({ message: 'Nombre es requerido' });
  try {
    const db = await getPool();
    const [dup] = await db.query('SELECT id FROM aseguradoras WHERE LOWER(nombre)=LOWER(?) AND id<>?', [nombre, req.params.id]);
    if (dup.length) return res.status(409).json({ message: 'Ya existe una aseguradora con ese nombre' });
    await db.query(
      `UPDATE aseguradoras SET nombre=?,cuit=?,web=?,domicilio=?,entre_calles=?,codigo_postal=?,lat=?,lng=?,telefono=?,email=?,notas=? WHERE id=?`,
      [nombre, cuit||null, web||null, domicilio||null, entre_calles||null, codigo_postal||null, lat||null, lng||null, telefono||null, email||null, notas||null, req.params.id]
    );
    await registrarAuditoria(req, 'aseguradoras', 'editar', req.params.id, `Aseguradora actualizada: ${nombre}`);
    res.json({ message: 'Actualizada' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/aseguradoras/:id', async (req, res) => {
  try {
    const db = await getPool();
    if (!await checkPuedeEliminar(req, res)) return;
    const [inUse] = await db.query('SELECT COUNT(*) as c FROM vehiculo_seguros WHERE aseguradora_id=?', [req.params.id]);
    if (inUse[0].c > 0) return res.status(409).json({ message: `No se puede eliminar: tiene ${inUse[0].c} póliza(s) asociada(s)` });
    const [as] = await db.query('SELECT nombre FROM aseguradoras WHERE id=?', [req.params.id]);
    await db.query('DELETE FROM aseguradoras WHERE id=?', [req.params.id]);
    await registrarAuditoria(req, 'aseguradoras', 'eliminar', req.params.id, `Aseguradora eliminada: ${as[0]?.nombre||req.params.id}`);
    res.json({ message: 'Eliminada' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Contactos de aseguradora
app.get('/api/aseguradoras/:id/contactos', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM aseguradoras_contactos WHERE aseguradora_id=? ORDER BY nombre ASC', [req.params.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/aseguradoras/:id/contactos', async (req, res) => {
  const { nombre, cargo, telefono, celular, email } = req.body;
  if (!nombre) return res.status(400).json({ message: 'Nombre del contacto requerido' });
  try {
    const db = await getPool();
    const [r] = await db.query(
      `INSERT INTO aseguradoras_contactos (aseguradora_id,nombre,cargo,telefono,celular,email) VALUES (?,?,?,?,?,?)`,
      [req.params.id, nombre, cargo||null, telefono||null, celular||null, email||null]
    );
    await registrarAuditoria(req, 'aseguradoras', 'contacto-crear', req.params.id, `Contacto creado: ${nombre}${cargo ? ` (${cargo})` : ''} — aseguradora_id=${req.params.id}`);
    res.status(201).json({ id: r.insertId, aseguradora_id: req.params.id, nombre, cargo, telefono, celular, email });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put('/api/aseguradoras/:id/contactos/:cid', async (req, res) => {
  const { nombre, cargo, telefono, celular, email } = req.body;
  if (!nombre) return res.status(400).json({ message: 'Nombre requerido' });
  try {
    const db = await getPool();
    await db.query(
      `UPDATE aseguradoras_contactos SET nombre=?,cargo=?,telefono=?,celular=?,email=? WHERE id=? AND aseguradora_id=?`,
      [nombre, cargo||null, telefono||null, celular||null, email||null, req.params.cid, req.params.id]
    );
    await registrarAuditoria(req, 'aseguradoras', 'contacto-editar', req.params.id, `Contacto actualizado: ${nombre} — aseguradora_id=${req.params.id}`);
    res.json({ message: 'Actualizado' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/aseguradoras/:id/contactos/:cid', async (req, res) => {
  try {
    const db = await getPool();
    const [[ct]] = await db.query('SELECT nombre FROM aseguradoras_contactos WHERE id=?', [req.params.cid]);
    await db.query('DELETE FROM aseguradoras_contactos WHERE id=? AND aseguradora_id=?', [req.params.cid, req.params.id]);
    await registrarAuditoria(req, 'aseguradoras', 'contacto-eliminar', req.params.id, `Contacto eliminado: ${ct?.nombre||req.params.cid} — aseguradora_id=${req.params.id}`);
    res.json({ message: 'Eliminado' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// 2. VTV (GET, POST)
app.get('/api/vehiculos/:id/vtv', async (req, res) => {
  const { id } = req.params;
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM vehiculo_vtv WHERE vehiculo_id = ? ORDER BY vigencia_hasta DESC', [id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/vehiculos/:id/vtv', async (req, res) => {
  const { id } = req.params;
  const { vigencia_desde, vigencia_hasta, archivo_adjunto, resultado, patente_vtv, fecha_inspeccion, notas, nro_inspeccion, nro_oblea } = req.body;
  if (!vigencia_desde || !vigencia_hasta) {
    return res.status(400).json({ message: 'Vigencia desde y hasta son obligatorios' });
  }
  try {
    const db = await getPool();
    const [[veh]] = await db.query('SELECT patente FROM vehiculos WHERE id=?', [id]);
    const [r] = await db.query(
      `INSERT INTO vehiculo_vtv (vehiculo_id, vigencia_desde, vigencia_hasta, archivo_adjunto, resultado, patente_vtv, fecha_inspeccion, notas, nro_inspeccion, nro_oblea) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, vigencia_desde, vigencia_hasta, archivo_adjunto||null, resultado||null, patente_vtv||null, fecha_inspeccion||null, notas||null, nro_inspeccion||null, nro_oblea||null]
    );
    await registrarAuditoria(req, 'vehiculos', 'vtv_agregar', id, `VTV agregada para ${veh?.patente||id} — vigencia hasta ${vigencia_hasta}`);
    // Generar alerta si vence en ≤60 días
    const hasta = new Date(vigencia_hasta);
    const hoy = new Date();
    const dias = Math.ceil((hasta - hoy) / 86400000);
    if (dias <= 60) {
      const msg = dias < 0
        ? `VTV VENCIDA hace ${Math.abs(dias)} días`
        : `VTV vence en ${dias} días (${vigencia_hasta})`;
      await db.query(
        `INSERT INTO alertas_vencimiento (vehiculo_id, tipo, referencia_id, mensaje, fecha_vencimiento) VALUES (?,?,?,?,?)`,
        [id, 'vtv', r.insertId, msg, vigencia_hasta]
      ).catch(()=>{});
    }
    res.status(201).json({ message: 'Registro de VTV guardado correctamente', id: r.insertId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 3. GNC (GET, POST)
app.get('/api/vehiculos/:id/gnc', async (req, res) => {
  const { id } = req.params;
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM vehiculo_gnc WHERE vehiculo_id = ? ORDER BY vigencia_hasta DESC', [id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/vehiculos/:id/gnc', async (req, res) => {
  const { id } = req.params;
  const { vigencia_desde, vigencia_hasta, archivo_adjunto } = req.body;
  if (!vigencia_desde || !vigencia_hasta) {
    return res.status(400).json({ message: 'Vigencia desde y hasta son obligatorios' });
  }
  try {
    const db = await getPool();
    const [[vehGnc]] = await db.query('SELECT patente FROM vehiculos WHERE id=?', [id]);
    const [rGnc] = await db.query(`
      INSERT INTO vehiculo_gnc (vehiculo_id, vigencia_desde, vigencia_hasta, archivo_adjunto)
      VALUES (?, ?, ?, ?)
    `, [id, vigencia_desde, vigencia_hasta, archivo_adjunto || null]);
    await registrarAuditoria(req, 'vehiculos', 'gnc_agregar', id, `GNC agregado para ${vehGnc?.patente||id} — vigencia hasta ${vigencia_hasta}`);
    res.status(201).json({ message: 'Registro de GNC guardado correctamente' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 4. SEGUROS (GET, POST)
app.get('/api/vehiculos/:id/seguros', async (req, res) => {
  const { id } = req.params;
  try {
    const db = await getPool();
    const [rows] = await db.query(`
      SELECT vs.*, a.nombre as aseguradora_nombre 
      FROM vehiculo_seguros vs
      INNER JOIN aseguradoras a ON vs.aseguradora_id = a.id
      WHERE vs.vehiculo_id = ? 
      ORDER BY vs.vigencia_hasta DESC
    `, [id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/vehiculos/:id/seguros', async (req, res) => {
  const { id } = req.params;
  const { aseguradora_id, nro_poliza, vigencia_desde, vigencia_hasta, archivo_adjunto } = req.body;
  if (!aseguradora_id || !nro_poliza || !vigencia_desde || !vigencia_hasta) {
    return res.status(400).json({ message: 'Aseguradora, póliza y vigencias son obligatorios' });
  }
  try {
    const db = await getPool();
    const [[vehSeg]] = await db.query('SELECT patente FROM vehiculos WHERE id=?', [id]);
    await db.query(`
      INSERT INTO vehiculo_seguros (vehiculo_id, aseguradora_id, nro_poliza, vigencia_desde, vigencia_hasta, archivo_adjunto)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [id, aseguradora_id, nro_poliza, vigencia_desde, vigencia_hasta, archivo_adjunto || null]);
    await registrarAuditoria(req, 'vehiculos', 'seguro_agregar', id, `Seguro agregado para ${vehSeg?.patente||id} — póliza ${nro_poliza}, hasta ${vigencia_hasta}`);
    res.status(201).json({ message: 'Registro de Seguro guardado correctamente' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 5. Marcas y Modelos (GET)
app.get('/api/marcas', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM marcas ORDER BY nombre ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/modelos', async (req, res) => {
  const { marca_id } = req.query;
  try {
    const db = await getPool();
    let query = 'SELECT * FROM modelos';
    let params = [];
    if (marca_id) {
      query += ' WHERE marca_id = ?';
      params.push(marca_id);
    }
    query += ' ORDER BY nombre ASC';
    const [rows] = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 6. Services de un Vehículo (GET)
app.get('/api/vehiculos/:id/services', async (req, res) => {
  const { id } = req.params;
  try {
    const db = await getPool();
    const [rows] = await db.query(`
      SELECT s.*, p.nombre as proveedor
      FROM services s
      LEFT JOIN proveedores p ON s.proveedor_id = p.id
      WHERE s.vehiculo_id = ?
      ORDER BY s.fecha DESC
    `, [id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 7. OCR / Extracción de Datos de Cédula (POST) — soporta imágenes Y PDFs
app.post('/api/ocr/cedula', upload.single('cedula_img'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No se subió ningún archivo' });
  }

  const filePath = req.file.path;
  const fileName = req.file.filename;
  const mimeType = req.file.mimetype || '';
  const extLower = path.extname(req.file.originalname || '').toLowerCase();
  console.log(`[OCR] Recibido: ${fileName} (${mimeType})`);

  try {
    let text = '';

    if (mimeType === 'application/pdf' || extLower === '.pdf') {
      // ── PDF: extraer texto embebido con pdf-parse ──────────────────────────
      const pdfParse = require('pdf-parse');
      const pdfBuffer = fs.readFileSync(filePath);
      const pdfData   = await pdfParse(pdfBuffer);
      text = pdfData.text || '';
      console.log(`[OCR-PDF] Texto extraído (${text.length} chars)`);
    } else {
      // ── Imagen: preprocesar + Tesseract OCR con fallback ───────────────────
      text = await ocrWithFallback(filePath, 'spa+eng');
      console.log(`[OCR-IMG] Texto extraído (${text.length} chars)`);
    }

    console.log(text);
    
    const textUpper = text.toUpperCase();

    // Parseo por Regex genérico — funciona con cédulas verdes, pólizas, obleas, etc.
    // Patente/Dominio: viejo (ABC123) y nuevo (AB123CD) formato argentino
    const patenteMatch = textUpper.match(/(?:DOMINIO|PATENTE)\s*[:\-]?\s*([A-Z]{2,3}\d{3}[A-Z]{0,2})/);
    const chasisMatch = textUpper.match(/CHASIS\s*[:\-]?\s*([A-Z0-9]{10,20})/);
    const motorMatch = textUpper.match(/MOTOR\s*[:\-]?\s*([A-Z0-9]{5,20})/);
    
    // Titular: "ASEGURADO:", "TITULAR:" o nombre en mayúsculas después de esa etiqueta
    const titularMatch = textUpper.match(/(?:ASEGURADO|TITULAR)\s*:\s*([A-ZÁÉÍÓÚÜÑ\s]+?)(?:\n|DNI|CUIL|$)/);
    const titularNombre = titularMatch ? titularMatch[1].trim() : '';
    const titularDniMatch = textUpper.match(/DNI\s*(?:N[oº°]?)?\s*:?\s*(\d{7,8})/);

    // Año del vehículo
    const añoMatch = textUpper.match(/(?:AÑO|ANO)\s*[:\-]?\s*(\d{4})/);
    const año = añoMatch ? añoMatch[1] : '';

    // Buscar marca y modelo en base de datos si aparecen en el texto
    const db = await getPool();
    const [marcasRows] = await db.query('SELECT * FROM marcas ORDER BY LENGTH(nombre) DESC'); // primero los más largos
    let detectedMarcaId = null;
    let detectedModeloId = null;
    let detectedMarcaNombre = '';
    let detectedModeloNombre = '';

    for (const m of marcasRows) {
      if (textUpper.includes(m.nombre.toUpperCase())) {
        detectedMarcaId = m.id;
        detectedMarcaNombre = m.nombre;
        // Buscar modelos de esta marca en el texto (también ordenados por longitud)
        const [modelosRows] = await db.query('SELECT * FROM modelos WHERE marca_id = ? ORDER BY LENGTH(nombre) DESC', [m.id]);
        for (const mod of modelosRows) {
          if (mod.nombre && textUpper.includes(mod.nombre.toUpperCase())) {
            detectedModeloId = mod.id;
            detectedModeloNombre = mod.nombre;
            break;
          }
        }
        break;
      }
    }

    res.json({
      success: true,
      patente:       patenteMatch ? patenteMatch[1].trim() : '',
      marca_id:      detectedMarcaId,
      marca:         detectedMarcaNombre,
      modelo_id:     detectedModeloId,
      modelo:        detectedModeloNombre,
      chasis:        chasisMatch ? chasisMatch[1].trim() : '',
      motor:         motorMatch  ? motorMatch[1].trim()  : '',
      año:           año,
      titular_nombre: titularNombre || '',
      titular_dni:   titularDniMatch ? titularDniMatch[1] : '',
      archivo_url:   `/uploads/${fileName}`,
      raw_text:      text
    });
  } catch (err) {
    console.error('[OCR] Error en escaneo OCR:', err.message);
    res.status(500).json({ message: 'Error en OCR', error: err.message });
  }
});

// ── Evitar que errores no capturados tumben el servidor ──────────────────────
process.on('uncaughtException', err => {
  // EBUSY en archivos de sesión wwebjs (Windows): Chrome retiene el lock del journal de SQLite
  if (err.code === 'EBUSY' && err.path && err.path.includes('.wwebjs_auth')) return;
  console.error('[PROCESO] uncaughtException:', err.message);
});
process.on('unhandledRejection', err => {
  if (err?.code === 'EBUSY' && err?.path && err.path.includes('.wwebjs_auth')) return;
  console.error('[PROCESO] unhandledRejection:', err?.message || err);
});

// ── Bot Telegram ──────────────────────────────────────────────────────────────
let _tgBot = null;
function _initTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.log('[TG] TELEGRAM_BOT_TOKEN no configurado — bot desactivado.'); return; }
  try {
    const TelegramBotModule = require('node-telegram-bot-api');
    const TelegramBot = TelegramBotModule.default || TelegramBotModule;
    _tgBot = new TelegramBot(token, { polling: false });
    _tgBot.getMe().then(me => console.log(`[TG] Bot conectado: @${me.username}`)).catch(e => {
      console.error('[TG] Token inválido:', e.message);
      _tgBot = null;
    });
  } catch(e) { console.error('[TG] Error al iniciar bot:', e.message); }
}

app.get('/api/telegram/status', requireAuth, (req, res) => {
  if (!process.env.TELEGRAM_BOT_TOKEN) return res.json({ configured: false, online: false, reason: 'sin_token' });
  if (!_tgBot) return res.json({ configured: true, online: false, reason: 'error_init' });
  _tgBot.getMe()
    .then(me => res.json({ configured: true, online: true, username: me.username }))
    .catch(() => res.json({ configured: true, online: false, reason: 'api_error' }));
});

app.post('/api/telegram/send', requireAuth, async (req, res) => {
  if (!_tgBot) return res.status(503).json({ message: 'Bot de Telegram no configurado. Agregá TELEGRAM_BOT_TOKEN en .env' });
  const { chatId, message, xlsBase64, xlsFilename, mediaBase64, mediaMime, mediaFilename, audit } = req.body;
  if (!chatId) return res.status(400).json({ message: 'chatId requerido' });
  try {
    if (xlsBase64 && xlsFilename) {
      const buf = Buffer.from(xlsBase64, 'base64');
      await _tgBot.sendDocument(chatId, buf, { caption: message || '' }, { filename: xlsFilename, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    } else if (mediaBase64 && mediaMime) {
      const buf = Buffer.from(mediaBase64, 'base64');
      const fname = mediaFilename || 'adjunto';
      if (mediaMime.startsWith('image/')) {
        await _tgBot.sendPhoto(chatId, buf, { caption: message || '' }, { filename: fname, contentType: mediaMime });
      } else if (mediaMime.startsWith('video/')) {
        await _tgBot.sendVideo(chatId, buf, { caption: message || '' }, { filename: fname, contentType: mediaMime });
      } else {
        await _tgBot.sendDocument(chatId, buf, { caption: message || '' }, { filename: fname, contentType: mediaMime });
      }
    } else {
      await _tgBot.sendMessage(chatId, message || '', { parse_mode: 'Markdown' });
    }
    const tipoLabel = { chofer: 'Chofer', propietario: 'Propietario', manual: 'Chat ID manual' };
    const desc = `Telegram enviado a ${tipoLabel[audit?.recipientTipo] || 'contacto'}: ${audit?.recipientNombre || chatId} (${chatId})` +
      (audit?.docName   ? ` — Módulo: ${audit.docName}` : '') +
      (xlsFilename      ? ` — Archivo: ${xlsFilename}` : '');
    await registrarAuditoria(req, 'telegram', 'enviar', audit?.recipientId || null, desc);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ message: err.message }); }
});

// --- INICIALIZACIÓN DE LA APLICACIÓN Y BOT DE WHATSAPP ---

let botReadyStatus = false;
let currentQR = null;
let _waGroupsCache = [];

// ── Multi-sesión WhatsApp ─────────────────────────────────────────────────────
// Cada sesión tiene { client, ready, qr, destroying }
const waSessions = new Map();

// Estado de facturación pendiente: mientras el bot Facturitas procesa una factura,
// guardamos el pago_id para vincular el PDF cuando llegue como media.
let _pendingFactura = null;   // { pagoId, ts }
let _lastPdfFacturitas = null; // { data, mimetype, ts } — último PDF recibido de Facturitas, para recuperación manual
const FACTURITAS_NUMBER  = '12394219557';
const FACTURITAS_LID     = '274504764887078';
const _isFacturitas = (bare) => bare === FACTURITAS_NUMBER || bare === FACTURITAS_LID;
const _factMsgProcessed = new Set();

// Descarga manual de media WA: usa directPath + mediaKey de message._data
// cuando downloadMedia() falla (común con cuentas @lid en wwebjs)
async function _downloadWAMediaManual(message) {
  try {
    const d = message._data || {};
    const directPath = d.directPath || message.directPath;
    const mediaKeyB64 = d.mediaKey || message.mediaKey;
    if (!directPath || !mediaKeyB64) {
      console.log('[FACTURITAS][manual] Sin directPath/mediaKey en _data');
      return null;
    }
    // HKDF expand: deriva IV (16) + cipherKey (32) + macKey (32) desde mediaKey (32)
    const mediaKey = Buffer.from(mediaKeyB64, 'base64');
    const typeLabel = message.type === 'document' ? 'Document'
                    : message.type === 'image'    ? 'Image'
                    : message.type === 'audio'    ? 'Audio'
                    : message.type === 'video'    ? 'Video' : 'Document';
    const info = Buffer.from(`WhatsApp ${typeLabel} Keys`);
    const expanded = Buffer.from(
      require('crypto').hkdfSync('sha256', mediaKey, Buffer.alloc(32, 0), info, 112)
    );
    const iv         = expanded.slice(0,  16);
    const cipherKey  = expanded.slice(16, 48);
    // Descargar archivo cifrado desde CDN de WhatsApp
    const url = `https://mmg.whatsapp.net${directPath}`;
    console.log(`[FACTURITAS][manual] Descargando desde CDN: ${url.slice(0,80)}...`);
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'WhatsApp/2.24.10.76 A',
        'Origin': 'https://web.whatsapp.com',
        'Referer': 'https://web.whatsapp.com/',
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) { console.log(`[FACTURITAS][manual] CDN HTTP ${resp.status}`); return null; }
    const encBuf = Buffer.from(await resp.arrayBuffer());
    // Descifrar AES-256-CBC (los últimos 10 bytes son MAC, no forman parte del ciphertext)
    const ciphertext = encBuf.slice(0, -10);
    const decipher = require('crypto').createDecipheriv('aes-256-cbc', cipherKey, iv);
    decipher.setAutoPadding(true);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const mimetype = d.mimetype || 'application/pdf';
    console.log(`[FACTURITAS][manual] ✓ Descifrado OK: ${decrypted.length} bytes, mime=${mimetype}`);
    return { data: decrypted.toString('base64'), mimetype, filename: d.filename || null };
  } catch (err) {
    console.error('[FACTURITAS][manual] Error descarga manual:', err.message);
    return null;
  }
}

async function _captureFacturaPDF(message) {
  // Deduplicar: solo bloquear si el mensaje ya fue procesado EXITOSAMENTE
  const msgId = message.id?._serialized || message.id?.id || null;
  if (msgId && _factMsgProcessed.has(msgId)) {
    console.log(`[FACTURITAS] msg ${msgId} ya procesado, skip`);
    return;
  }
  try {
    // downloadMedia con retry agresivo — el PDF de Facturitas a veces llega antes de que
    // el media esté disponible en los servidores de WA
    let media = null;
    const delays = [1000, 2000, 3000, 4000, 5000, 6000];
    for (let _i = 0; _i < delays.length; _i++) {
      try {
        media = await message.downloadMedia();
        if (media?.data) break;
      } catch(_e) {
        console.log(`[FACTURITAS] downloadMedia intento ${_i+1} falló: ${_e.message}`);
      }
      await new Promise(r => setTimeout(r, delays[_i]));
    }
    // Fallback 1: leer de _data.body (algunos mensajes wwebjs exponen base64 directamente)
    if (!media?.data && (message._data?.body || message._data?.mediaData?.body)) {
      const raw = message._data?.body || message._data?.mediaData?.body;
      const mt  = message._data?.mimetype || message._data?.mediaData?.mimetype || 'application/pdf';
      media = { data: raw, mimetype: mt };
      console.log(`[FACTURITAS] media obtenido de _data.body (fallback1), mime=${mt}`);
    }
    // Fallback 2: descarga manual via CDN con directPath + mediaKey (funciona con @lid)
    if (!media?.data) {
      console.log('[FACTURITAS] downloadMedia falló — intentando descarga manual CDN...');
      media = await _downloadWAMediaManual(message);
    }
    console.log(`[FACTURITAS] media final: mime=${media?.mimetype} size=${media?.data?.length}`);
    if (!media?.data) {
      console.warn('[FACTURITAS] No se pudo obtener media por ningún método');
      return;
    }
    // Aceptar: PDF explícito, o documento cuyo mime sea desconocido pero type=document de Facturitas
    const isPdf = media.mimetype?.includes('pdf')
               || (!media.mimetype && message.type === 'document');
    if (!isPdf) {
      console.log(`[FACTURITAS] descartado — no es PDF (mime=${media.mimetype}, type=${message.type})`);
      return;
    }
    if (!media.mimetype) media.mimetype = 'application/pdf'; // normalizar
    // Guardar el último PDF en memoria Y en disco — así sobrevive reinicios del server
    _lastPdfFacturitas = { data: media.data, mimetype: media.mimetype, ts: Date.now() };
    try {
      const _lpDir = path.join(__dirname, 'public', 'uploads', 'facturas');
      fs.mkdirSync(_lpDir, { recursive: true });
      fs.writeFileSync(path.join(_lpDir, '_last_facturitas.pdf'), Buffer.from(media.data, 'base64'));
    } catch(_lpErr) { console.warn('[FACTURITAS] No se pudo persistir last PDF a disco:', _lpErr.message); }

    const db = await getPool();
    let pagoId = null;

    // 1) Prioridad: _pendingFactura en memoria (set al invocar /facturar desde la UI)
    if (_pendingFactura?.pagoId) {
      pagoId = _pendingFactura.pagoId;
      console.log(`[FACTURITAS] PDF recibido — usando _pendingFactura pagoId=${pagoId}`);
    }

    // 2) Fallback: extraer nro de operación del caption/body del mensaje para matchear
    if (!pagoId) {
      const caption = (message.body || message.caption || '').trim();
      // Facturitas envía el nombre del servicio como caption: "Alquiler (Op. 168886284276)"
      const mOp = caption.match(/Op\.\s*(\d{6,})/i);
      const mCob = caption.match(/Cob\.\s*(\d+)/i);
      if (mOp) {
        const nro = mOp[1];
        const [[row]] = await db.query(
          "SELECT id FROM pagos WHERE nro_transaccion=? AND factura_ref='pending' LIMIT 1", [nro]
        );
        if (row) { pagoId = row.id; console.log(`[FACTURITAS] PDF matcheado por Op. ${nro} → pago #${pagoId}`); }
      } else if (mCob) {
        pagoId = parseInt(mCob[1]);
        console.log(`[FACTURITAS] PDF matcheado por Cob. ${pagoId}`);
      }
    }

    // 3) Último recurso: el pago pending más reciente
    if (!pagoId) {
      const [[row]] = await db.query(
        "SELECT id FROM pagos WHERE factura_ref='pending' ORDER BY id DESC LIMIT 1"
      );
      pagoId = row?.id;
      if (pagoId) console.log(`[FACTURITAS] PDF recibido — fallback al último pending pagoId=${pagoId}`);
    }

    if (!pagoId) { console.warn('[FACTURITAS] PDF recibido pero no hay cobro pendiente'); return; }

    // Marcar como procesado exitosamente recién aquí (download OK + pagoId encontrado)
    if (msgId) {
      _factMsgProcessed.add(msgId);
      setTimeout(() => _factMsgProcessed.delete(msgId), 60000);
    }

    const buf = Buffer.from(media.data, 'base64');
    const dir = path.join(__dirname, 'public', 'uploads', 'facturas');
    fs.mkdirSync(dir, { recursive: true });
    const fname = `factura_${pagoId}_${Date.now()}.pdf`;
    fs.writeFileSync(path.join(dir, fname), buf);
    const factura_url = `/uploads/facturas/${fname}`;
    await db.query("UPDATE pagos SET factura_url=?, factura_ref=NULL WHERE id=?", [factura_url, pagoId]);
    console.log(`[FACTURITAS] ✓ PDF vinculado a pago #${pagoId}: ${factura_url}`);
    if (_pendingFactura?.pagoId === pagoId) _pendingFactura = null;
  } catch (err) { console.error('[FACTURITAS] Error al guardar PDF:', err.message); }
}

// Helper: resuelve el chatId correcto usando getNumberId (maneja protocolo LID nuevo de WA)
async function _resolveWaChatId(client, phone) {
  const bare = phone.replace(/[^\d]/g, '');
  try {
    const numberId = await client.getNumberId(bare);
    if (numberId && numberId._serialized) return numberId._serialized;
  } catch(_) {}
  return phone.includes('@') ? phone : `${phone}@c.us`;
}

function _buildWaClient(sid) {
  if (waSessions.has(sid) && !waSessions.get(sid).destroying) return waSessions.get(sid);
  const { Client, LocalAuth } = require('whatsapp-web.js');
  const puppeteerArgs = ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas','--no-first-run','--no-zygote','--disable-gpu'];
  const c = new Client({
    authStrategy: new LocalAuth({ clientId: sid }),
    puppeteer: { headless: true, args: puppeteerArgs },
    webVersion: '2.3000.1042234044',
    webVersionCache: { type: 'local', path: './.wwebjs_cache' }
  });
  const sess = { client: c, ready: false, qr: null, destroying: false };
  waSessions.set(sid, sess);
  c.on('qr', qr => {
    sess.qr = qr; sess.ready = false;
    if (sid === 'default') { currentQR = qr; botReadyStatus = false; }
    console.log(`[WA:${sid}] QR listo`);
  });
  c.on('ready', () => {
    sess.ready = true; sess.qr = null;
    if (sid === 'default') { botReadyStatus = true; currentQR = null; }
    console.log(`[WA:${sid}] Conectado`);
    // Cachear grupos al conectar
    if (sid === 'default') setTimeout(async () => {
      try {
        const groups = await c.pupPage.evaluate(() => {
          try {
            const raw = window.require('WAWebCollections').Chat.getModelsArray();
            return raw
              .filter(ch => {
                try {
                  const idStr = ch.id?._serialized || '';
                  return (idStr.endsWith('@g.us') || ch.isGroup === true) && (ch.name || ch.formattedTitle);
                } catch(_) { return false; }
              })
              .map(ch => ({
                id: ch.id._serialized,
                name: ch.name || ch.formattedTitle || '',
                participants: ch.groupMetadata?.participants?.length || 0
              }));
          } catch(e) { return []; }
        });
        _waGroupsCache = groups.filter(g => g.id && g.name).sort((a, b) => a.name.localeCompare(b.name));
        console.log(`[WA] ${_waGroupsCache.length} grupos cacheados`);
      } catch(e) { console.warn('[WA] pupPage.evaluate falló:', e.message); }
    }, 3000);
  });
  c.on('disconnected', () => {
    sess.ready = false;
    if (sid === 'default') { botReadyStatus = false; }
    console.log(`[WA:${sid}] Desconectado`);
  });
  c.on('auth_failure', msg => {
    sess.ready = false; sess.qr = null;
    if (sid === 'default') { botReadyStatus = false; currentQR = null; }
    console.error(`[WA:${sid}] Auth failure:`, msg);
  });
  if (sid === 'default') {
    const qrcode = require('qrcode-terminal');
    c.on('qr', qr => qrcode.generate(qr, { small: true }));
    c.on('ready', () => console.log('[BOT] ¡Bot de WhatsApp conectado y listo!'));
    c.on('disconnected', () => console.log('[BOT] WhatsApp desconectado.'));
  }
  const _isContextError = e => e?.message && (
    e.message.includes('Execution context was destroyed') ||
    e.message.includes('detached Frame') ||
    e.message.includes('Target closed')
  );
  c.initialize().catch(async err => {
    console.error(`[WA:${sid}] Error init:`, err.message);
    if (sid === 'default') botReadyStatus = false;
    if (_isContextError(err)) {
      console.log(`[WA:${sid}] WhatsApp Web recargó la página durante init — reintentando en 8s…`);
      await new Promise(r => setTimeout(r, 8000));
      if (!sess.destroying && !sess.ready) {
        console.log(`[WA:${sid}] Reintento de inicialización…`);
        c.initialize().catch(err2 => {
          console.error(`[WA:${sid}] Error en reintento init:`, err2.message);
          if (sid === 'default') botReadyStatus = false;
        });
      }
    }
  });
  return sess;
}

// Endpoints multi-sesión (fuera de startApp para que estén disponibles desde el inicio)
app.post('/api/whatsapp/connect/:sid', requireAuth, (req, res) => {
  const { sid } = req.params;
  if (!/^[\w\-]+$/.test(sid) || sid === 'default') return res.status(400).json({ message: 'sid inválido' });
  const sess = waSessions.get(sid);
  if (sess && !sess.destroying) {
    if (sess.ready) return res.json({ status: 'connected' });
    return res.json({ status: sess.qr ? 'waiting_qr' : 'initializing' });
  }
  _buildWaClient(sid);
  res.json({ status: 'initializing' });
});

app.get('/api/whatsapp/qr/:sid', async (req, res) => {
  const { sid } = req.params;
  const sess = waSessions.get(sid);
  if (!sess) return res.json({ connected: false, qr: null, status: 'not_started' });
  if (sess.ready) return res.json({ connected: true, status: 'connected' });
  if (!sess.qr)   return res.json({ connected: false, qr: null, status: 'initializing' });
  try {
    const QRCode = require('qrcode');
    const dataUrl = await QRCode.toDataURL(sess.qr, { width: 300, margin: 2 });
    res.json({ connected: false, qr: dataUrl, status: 'waiting_qr' });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/whatsapp/status/:sid', (req, res) => {
  const { sid } = req.params;
  const sess = waSessions.get(sid);
  if (!sess) return res.json({ status: 'not_started', ready: false });
  res.json({ status: sess.ready ? 'connected' : (sess.qr ? 'waiting_qr' : 'initializing'), ready: sess.ready });
});

app.delete('/api/whatsapp/disconnect/:sid', requireAuth, async (req, res) => {
  const { sid } = req.params;
  const sess = waSessions.get(sid);
  if (!sess) return res.json({ ok: true });
  sess.destroying = true;
  try { await sess.client.destroy(); } catch(_) {}
  waSessions.delete(sid);
  if (sid === 'default') { botReadyStatus = false; currentQR = null; }
  res.json({ ok: true });
});

// Desconectar bot principal
app.delete('/api/bot-disconnect', requireAuth, async (req, res) => {
  const sess = waSessions.get('default');
  if (sess) {
    sess.destroying = true;
    try { await sess.client.destroy(); } catch(_) {}
    waSessions.delete('default');
  }
  botReadyStatus = false;
  currentQR = null;
  res.json({ ok: true });
});

// Reconectar bot principal (clearAuth=1 borra sesión guardada → nuevo QR)
app.post('/api/bot-reconnect', requireAuth, async (req, res) => {
  if (req.query.clearAuth === '1') {
    // Destruir sesión activa si existe
    const sess = waSessions.get('default');
    if (sess) {
      sess.destroying = true;
      try { await sess.client.destroy(); } catch(_) {}
      waSessions.delete('default');
    }
    // Borrar carpeta de auth local para forzar QR nuevo
    const fs = require('fs');
    const authPath = require('path').join(__dirname, '.wwebjs_auth', 'session-default');
    try { fs.rmSync(authPath, { recursive: true, force: true }); } catch(_) {}
    botReadyStatus = false; currentQR = null;
  }
  const newSess = _buildWaClient('default');
  _attachDefaultBotHandlers(newSess.client);
  res.json({ ok: true });
});

async function startApp() {
  try {
    console.log('[BOT] Inicializando base de datos...');
    await initializeDatabase();
    await loadConfigFromDB(); // cargar API keys de DB si no están en .env
    // Inyectar pool en afip-service para persistir tokens entre reinicios
    require('./afip-service').setDb(await getPool());

    // 1. Levantar Servidor Web Express
    app.listen(PORT, () => {
      console.log(`[SERVER] Panel de control corriendo en http://localhost:${PORT}`);
    });

    // Telegram bot
    _initTelegramBot();

    // 2. Configurar endpoints para el estado del bot en la UI
    app.get('/api/bot-status', (req, res) => {
      res.json({ online: botReadyStatus, qrReady: !!currentQR });
    });

    app.get('/api/whatsapp/qr', async (req, res) => {
      if (botReadyStatus) return res.json({ connected: true });
      if (!currentQR)     return res.json({ connected: false, qr: null });
      try {
        const QRCode = require('qrcode');
        const dataUrl = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });
        res.json({ connected: false, qr: dataUrl });
      } catch(e) { res.status(500).json({ message: e.message }); }
    });

    // ── Buscar responsable de vehículo en chats de WhatsApp ──────────────────
    // Lee chats de todos los choferes con celular registrado, busca mensajes
    // alrededor de la fecha/hora de la multa, y usa IA para determinar quién tenía el vehículo.
    app.post('/api/whatsapp/buscar-responsable', async (req, res) => {
      if (!botReadyStatus) return res.status(503).json({ message: 'WhatsApp no conectado' });
      const { multa_id, fecha_infraccion, hora_infraccion, patente, vehiculo_id } = req.body;
      if (!fecha_infraccion || !patente) return res.status(400).json({ message: 'fecha_infraccion y patente requeridos' });

      try {
        const db = await getPool();

        // Todos los choferes con teléfono cargado
        const [choferes] = await db.query(`SELECT id, nombre, telefono FROM choferes WHERE telefono IS NOT NULL AND telefono != ''`);
        if (!choferes.length) return res.status(404).json({ message: 'Ningún chofer tiene número de teléfono cargado en el sistema' });

        // Fecha objetivo ± 3 días para la búsqueda
        const fechaBase  = new Date(fecha_infraccion + 'T' + (hora_infraccion || '12:00') + ':00');
        const fechaDesde = new Date(fechaBase.getTime() - 3 * 86400000);
        const fechaHasta = new Date(fechaBase.getTime() + 1 * 86400000);

        // Normalizar número argentino a formato WhatsApp (549XXXXXXXXXX@c.us)
        function normalizarTelefono(tel) {
          let n = tel.replace(/\D/g, '');
          if (n.startsWith('0')) n = n.substring(1);
          if (n.startsWith('15')) n = n.substring(2);
          if (!n.startsWith('549')) {
            if (n.startsWith('54')) n = '549' + n.substring(2);
            else if (n.startsWith('9'))  n = '54'  + n;
            else                          n = '549' + n;
          }
          return n + '@c.us';
        }

        const patenteNorm = patente.replace(/\s/g, '').toUpperCase();
        const resultadosPatente = []; // chats donde se menciona la patente (sin filtro de fecha)
        const resultadosFecha   = []; // chats con mensajes en el rango de fecha
        const errores           = [];

        for (const chofer of choferes) {
          const chatId = normalizarTelefono(chofer.telefono);
          try {
            const chat = await waSessions.get('default').client.getChatById(chatId);
            const allMsgs = await chat.fetchMessages({ limit: 1000 });

            // FASE 1: buscar mensajes que mencionan la patente (en cualquier fecha)
            const msgsPatente = allMsgs.filter(m => m.body && m.body.replace(/\s/g,'').toUpperCase().includes(patenteNorm));
            if (msgsPatente.length) {
              const conv = msgsPatente.map(m => {
                const quien = m.fromMe ? 'SISTEMA' : chofer.nombre;
                const ts    = new Date(m.timestamp * 1000).toLocaleString('es-AR');
                return `[${ts}] ${quien}: ${m.body}`;
              }).join('\n');
              resultadosPatente.push({ chofer, chatId, mensajes: msgsPatente.length, conv });
            }

            // FASE 2: mensajes en el rango de fecha de la infracción
            const msgsFecha = allMsgs.filter(m => {
              const ts = new Date(m.timestamp * 1000);
              return ts >= fechaDesde && ts <= fechaHasta;
            });
            if (msgsFecha.length) {
              const conv = msgsFecha.map(m => {
                const quien = m.fromMe ? 'SISTEMA' : chofer.nombre;
                const ts    = new Date(m.timestamp * 1000).toLocaleString('es-AR');
                return `[${ts}] ${quien}: ${m.body}`;
              }).join('\n');
              resultadosFecha.push({ chofer, chatId, mensajes: msgsFecha.length, conv });
            }
          } catch (e) {
            errores.push({ chofer: chofer.nombre, error: e.message });
          }
        }

        // Si no hay ningún chat útil, responder sin llamar a la IA
        if (!resultadosPatente.length && !resultadosFecha.length) {
          return res.json({
            encontrado: false,
            explicacion: 'No se encontraron menciones de la patente ni mensajes en el rango de fechas para ningún chofer',
            choferes_sin_chat: errores,
          });
        }

        // Construir contexto para la IA: primero patente, luego fecha
        // usa callAI centralizado

        let seccionPatente = '';
        if (resultadosPatente.length) {
          seccionPatente = `## MENSAJES QUE MENCIONAN LA PATENTE ${patente}\n` +
            resultadosPatente.map(r => `=== CHAT CON ${r.chofer.nombre} (tel: ${r.chofer.telefono}) ===\n${r.conv}`).join('\n\n');
        }

        let seccionFecha = '';
        if (resultadosFecha.length) {
          seccionFecha = `## MENSAJES EN EL RANGO DE FECHA (${fechaDesde.toLocaleDateString('es-AR')} – ${fechaHasta.toLocaleDateString('es-AR')})\n` +
            resultadosFecha.map(r => `=== CHAT CON ${r.chofer.nombre} (tel: ${r.chofer.telefono}) ===\n${r.conv}`).join('\n\n');
        }

        const prompt = `Sos un asistente de flota de vehículos de transporte argentino.
Tu tarea es determinar quién tenía asignado el vehículo con patente ${patente} el día ${fechaBase.toLocaleDateString('es-AR')} a las ${hora_infraccion || 'hora desconocida'}.

ESTRATEGIA:
1. Primero analizá si hay mensajes que mencionan directamente la patente ${patente} — eso es evidencia fuerte.
2. Si no, analizá los mensajes del rango de fecha para inferir quién estaba trabajando con ese vehículo.

${seccionPatente}

${seccionFecha}

Respondé ÚNICAMENTE con JSON válido:
{
  "encontrado": true/false,
  "confianza": "alta/media/baja",
  "chofer_responsable": { "id": 0, "nombre": "", "celular": "" },
  "evidencia": "cita textual del mensaje relevante",
  "fecha_mensaje": "fecha del mensaje clave",
  "explicacion": "resumen de por qué pensás que fue este chofer"
}
Si no hay evidencia suficiente → "encontrado": false, "chofer_responsable": null, "explicacion": razón.`.substring(0, 10000);

        const aiRes = await callAI('analizar-multa-whatsapp', [{ role: 'user', content: prompt }], { max_tokens: 800 });

        let analisis;
        try {
          analisis = JSON.parse(aiRes.content[0].text.trim());
          if (analisis.chofer_responsable?.nombre) {
            const match = choferes.find(c => c.nombre.toLowerCase().includes(analisis.chofer_responsable.nombre.toLowerCase()));
            if (match) { analisis.chofer_responsable.id = match.id; analisis.chofer_responsable.celular = match.telefono; }
          }
        } catch {
          analisis = { encontrado: false, explicacion: 'Error al parsear respuesta de IA: ' + aiRes.content[0].text };
        }

        const todosAnalizados = [...new Map([...resultadosPatente, ...resultadosFecha].map(r => [r.chofer.id, r])).values()];
        res.json({
          ...analisis,
          choferes_analizados: todosAnalizados.map(r => ({ nombre: r.chofer.nombre, mensajes: r.mensajes })),
          choferes_sin_chat: errores,
        });

      } catch (err) { res.status(500).json({ message: err.message }); }
    });

    // Historial de envíos WA a un destinatario + documento
    app.get('/api/whatsapp/historial', requireAuth, async (req, res) => {
      try {
        const db = await getPool();
        const { recipientId, docName } = req.query;
        const where = ["modulo='whatsapp'", "accion='enviar'"];
        const vals  = [];
        if (recipientId) { where.push('entidad_id=?'); vals.push(recipientId); }
        if (docName)     { where.push('descripcion LIKE ?'); vals.push(`%${docName}%`); }
        const [rows] = await db.query(
          `SELECT fecha, descripcion, usuario_nombre FROM auditoria WHERE ${where.join(' AND ')} ORDER BY fecha DESC LIMIT 50`,
          vals
        );
        // Post-filtrar con regex exacto para evitar que "Turno #42" matchee "Turno #4200", etc.
        const exact = docName
          ? rows.filter(r => new RegExp(docName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '(?!\\d)', 'i').test(r.descripcion))
          : rows;
        res.json(exact.slice(0, 10));
      } catch (err) { res.status(500).json({ message: err.message }); }
    });

    // Enviar mensaje/archivo por WhatsApp desde la UI
    app.post('/api/whatsapp/send', async (req, res) => {
      if (!botReadyStatus) return res.status(503).json({ message: 'Bot de WhatsApp no está conectado. Escaneá el QR en la consola.' });
      const { phone, message, xlsBase64, xlsFilename, mediaBase64, mediaMime, mediaFilename, audit } = req.body;
      if (!phone) return res.status(400).json({ message: 'Número requerido' });
      try {
        const client = waSessions.get('default').client;
        const { MessageMedia } = require('whatsapp-web.js');

        // _doSend: intenta enviar; si falla por frame detached, reintenta con @c.us directo
        const _doSend = async (chatId) => {
          if (xlsBase64 && xlsFilename) {
            const media = new MessageMedia(
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              xlsBase64, xlsFilename
            );
            await client.sendMessage(chatId, media, { caption: message || '' });
          } else if (mediaBase64 && mediaFilename) {
            const media = new MessageMedia(mediaMime || 'application/octet-stream', mediaBase64, mediaFilename);
            await client.sendMessage(chatId, media, { caption: message || '' });
          } else {
            await client.sendMessage(chatId, message || '');
          }
        };

        let chatId = await _resolveWaChatId(client, phone);
        try {
          await _doSend(chatId);
        } catch (sendErr) {
          if (sendErr.message && sendErr.message.includes('detached Frame')) {
            // Frame transitoriamente desconectado — reintentar con formato directo
            const bare = phone.replace(/[^\d]/g, '');
            chatId = `${bare}@c.us`;
            await new Promise(r => setTimeout(r, 800));
            await _doSend(chatId);
          } else {
            throw sendErr;
          }
        }

        // Auditoría
        const tipoLabel = { chofer: 'Chofer', propietario: 'Propietario', manual: 'Número manual' };
        const desc = `WhatsApp enviado a ${tipoLabel[audit?.recipientTipo] || 'contacto'}: ${audit?.recipientNombre || phone} (${phone})` +
          (audit?.docName ? ` — Módulo: ${audit.docName}` : '') +
          (xlsFilename    ? ` — Archivo: ${xlsFilename}` : '');
        await registrarAuditoria(req, 'whatsapp', 'enviar', audit?.recipientId || null, desc);
        res.json({ ok: true });
      } catch (err) { res.status(500).json({ message: err.message }); }
    });

    // Endpoint temporal: hacer click en un botón de WhatsApp (button_response) vía puppeteer
    app.post('/api/whatsapp/click-button', async (req, res) => {
      if (!botReadyStatus) return res.status(503).json({ message: 'WhatsApp no conectado' });
      const { phone, buttonText } = req.body;
      if (!phone || !buttonText) return res.status(400).json({ message: 'phone y buttonText requeridos' });
      try {
        const client = waSessions.get('default').client;
        const chatId = await _resolveWaChatId(client, phone);
        // Abrir el chat en la instancia puppeteer interna
        await client.pupPage.evaluate(async (cid) => {
          const Store = window.Store || {};
          if (Store.Cmd) Store.Cmd.openChatAt(cid);
        }, chatId);
        await new Promise(r => setTimeout(r, 1500));
        // Buscar y hacer click en el botón con el texto dado
        const clicked = await client.pupPage.evaluate((text) => {
          const sel = 'div[role="button"], button, [data-testid*="btn"]';
          const all = Array.from(document.querySelectorAll(sel));
          for (const el of all) {
            if (el.textContent.trim() === text || el.innerText?.trim() === text) {
              el.click();
              return true;
            }
          }
          return false;
        }, buttonText);
        res.json({ ok: true, clicked });
      } catch (err) { res.status(500).json({ message: err.message }); }
    });

    app.post('/api/whatsapp/send-doc', async (req, res) => {
      if (!botReadyStatus) return res.status(503).json({ message: 'Bot de WhatsApp no está conectado.' });
      const { phone, message, fileBase64, mimeType, filename, audit } = req.body;
      if (!phone || !fileBase64) return res.status(400).json({ message: 'Número y archivo requeridos' });
      try {
        const { MessageMedia } = require('whatsapp-web.js');
        const client = waSessions.get('default').client;
        const chatId = await _resolveWaChatId(client, phone);
        const media  = new MessageMedia(mimeType || 'application/octet-stream', fileBase64, filename || 'documento');
        await client.sendMessage(chatId, media, { caption: message || '' });
        // Registrar en auditoría
        const tipoLabel = { chofer: 'Chofer', usuario: 'Usuario', propietario: 'Propietario', numero_manual: 'Número manual' };
        const desc = `WhatsApp enviado a ${tipoLabel[audit?.recipientTipo] || audit?.recipientTipo || 'desconocido'}: ${audit?.recipientNombre || phone} — Documento: ${audit?.docName || filename || ''}`;
        await registrarAuditoria(req, 'whatsapp', 'enviar', audit?.recipientId || null, desc);
        res.json({ ok: true });
      } catch (err) { res.status(500).json({ message: err.message }); }
    });

    // Listar grupos de WhatsApp (usa cache; fuerza refresh con ?refresh=1)
    app.get('/api/whatsapp/groups', requireAuth, async (req, res) => {
      if (!botReadyStatus) return res.status(503).json({ message: 'Bot no conectado' });
      if (_waGroupsCache.length && !req.query.refresh) return res.json(_waGroupsCache);
      const client = waSessions.get('default').client;
      try {
        const groups = await client.pupPage.evaluate(() => {
          try {
            const raw = window.require('WAWebCollections').Chat.getModelsArray();
            return raw
              .filter(ch => {
                try {
                  const idStr = ch.id?._serialized || '';
                  return (idStr.endsWith('@g.us') || ch.isGroup === true) && (ch.name || ch.formattedTitle);
                } catch(_) { return false; }
              })
              .map(ch => ({
                id: ch.id._serialized,
                name: ch.name || ch.formattedTitle || '',
                participants: ch.groupMetadata?.participants?.length || 0
              }));
          } catch(e) { return []; }
        });
        _waGroupsCache = groups.filter(g => g.id && g.name).sort((a, b) => a.name.localeCompare(b.name));
        res.json(_waGroupsCache);
      } catch (err) {
        res.status(500).json({ message: err?.message || 'Error al obtener grupos' });
      }
    });

    // Enviar mensaje a múltiples grupos/chats
    app.post('/api/whatsapp/broadcast', requireAuth, async (req, res) => {
      if (!botReadyStatus) return res.status(503).json({ message: 'Bot no conectado' });
      const { targets, message } = req.body; // targets: [{ chatId, label }]
      if (!targets?.length || !message) return res.status(400).json({ message: 'targets y message requeridos' });
      try {
        const client = waSessions.get('default').client;
        const results = [];
        for (const t of targets) {
          try {
            await client.sendMessage(t.chatId, t.message || message);
            results.push({ chatId: t.chatId, label: t.label, ok: true });
            await new Promise(r => setTimeout(r, 1500)); // delay entre mensajes
          } catch (e) {
            results.push({ chatId: t.chatId, label: t.label, ok: false, error: e.message });
          }
        }
        await registrarAuditoria(req, 'whatsapp', 'broadcast', null, `Broadcast a ${targets.length} grupo(s): ${message.substring(0,80)}`);
        res.json({ results });
      } catch (err) { res.status(500).json({ message: err.message }); }
    });

    // 3. Inicializar Cliente de WhatsApp (sesión 'default')
    console.log('[BOT] Configurando cliente de WhatsApp...');
    const defaultSess = _buildWaClient('default');
    _attachDefaultBotHandlers(defaultSess.client);
  } catch (error) {
    console.error('[CRITICAL] Fallo de inicio de la aplicación:', error.message);
  }
} // fin startApp

// Cola de mensajes del bot CABA (alimentada desde el handler global)
let _cabaBotChatId = null;
const _cabaQueue = [];

// Registra handlers de mensajes en el cliente default.
// Se llama desde startApp Y desde bot-reconnect para que sobreviva reconexiones.
function _attachDefaultBotHandlers(client) {
    // Limpiar listeners previos para evitar acumulación en reconexiones
    client.removeAllListeners('message');
    client.removeAllListeners('message_create');

    client.on('message', async (message) => {
      try {
        // Ignorar mensajes de sistema (no tienen from válido)
        if (!message.from || typeof message.from !== 'string') return;
        if (message.type === 'notification_template' || message.type === 'notification') return;

        const body = (message.body || '').trim();
        // @lid = nuevo formato WA — el "from" no es el número real, hay que resolverlo
        let fromBare = message.from.replace(/[@:].*/,'').replace(/[^\d]/g,'');
        if (message.from.endsWith('@lid')) {
          try {
            const contact = await message.getContact();
            // id.user tiene el número real; contact.number puede devolver el LID
            const resolved = (contact.id?.user || contact.number || '').replace(/\D/g,'');
            if (resolved) { fromBare = resolved; }
            console.log(`[BOT][LID] Resolviendo @lid → id.user=${contact.id?.user} number=${contact.number} → fromBare=${fromBare}`);
          } catch(lidErr) {
            console.warn('[BOT][LID] No se pudo resolver @lid:', lidErr.message);
          }
        }
        console.log(`[BOT][Chat] Mensaje de ${message.from} (bare:${fromBare}) hasMedia:${message.hasMedia} type:${message.type} body="${body.slice(0,40)}"`);

        // Interceptar mensajes del bot CABA y encolarlo para el endpoint
        if (_cabaBotChatId && message.from === _cabaBotChatId && body) {
          _cabaQueue.push({ body, ts: Date.now() });
          console.log(`[CABA-BOT] encolado (queue=${_cabaQueue.length}): ${body.substring(0,60)}`);
        }
        if (body.toLowerCase() === '!ping') { await message.reply('pong'); return; }

        const isFact = _isFacturitas(fromBare);
        console.log(`[BOT][DBG] from=${message.from} bare=${fromBare} isFact=${isFact} hasMedia=${message.hasMedia} type=${message.type} body="${body.slice(0,40)}"`);

        // Captura de PDF de Facturitas — acepta document e image (wwebjs puede reportar tipos distintos según versión)
        if (isFact && message.hasMedia && message.type !== 'sticker') {
          _captureFacturaPDF(message).catch(e => console.error('[FACTURITAS] capture error:', e.message));
          return;
        }
        if (isFact) return; // otros mensajes de Facturitas: ignorar

        // Imagen recibida de un chofer → detectar si es comprobante de transferencia
        if (message.hasMedia && !message.isStatus && !isFact && !message.from.includes('@g.us')) {
          try {
            // downloadMedia con retry (wwebjs puede fallar con error transitorio)
            let media = null;
            // Intento 1: downloadMedia estándar
            try {
              media = await message.downloadMedia();
            } catch(_e) {
              console.log(`[WA-BOT] downloadMedia estándar falló: ${String(_e?.message || _e)}`);
            }

            // Intento 2: para mensajes @lid, los datos pueden estar en _data.body (base64 directo)
            if (!media && message.from.endsWith('@lid')) {
              try {
                const raw = message._data?.body || message._data?.mediaData?.body;
                const mt  = message._data?.mimetype || message._data?.mediaData?.mimetype || 'image/jpeg';
                if (raw) {
                  media = { data: raw, mimetype: mt, filename: null };
                  console.log(`[WA-BOT] Media obtenido de _data.body (lid fallback), mime=${mt}`);
                }
              } catch(_e2) {
                console.log(`[WA-BOT] Fallback _data.body falló: ${String(_e2?.message || _e2)}`);
              }
            }

            // Intento 3: retry con delay
            if (!media) {
              await new Promise(r => setTimeout(r, 3000));
              try {
                media = await message.downloadMedia();
                console.log(`[WA-BOT] downloadMedia retry OK`);
              } catch(_e3) {
                console.log(`[WA-BOT] downloadMedia retry falló: ${String(_e3?.message || _e3)}`);
              }
            }

            if (!media) {
              console.log(`[WA-BOT] No se pudo descargar media de ${fromBare} — abortando`);
              return;
            }
            const mime = (media?.mimetype || '');
            console.log(`[WA-BOT] Media descargado: mime=${mime} size=${media.data?.length}`);
            const esImagen = mime.startsWith('image/') || mime === 'application/octet-stream' ||
                             ['image/jpeg','image/png','image/webp','image/heic'].includes(mime);
            const esPdf = mime === 'application/pdf';
            if (!esImagen && !esPdf) {
              console.log(`[WA-BOT] Media recibido pero no es imagen ni PDF: ${mime}`);
              return;
            }

            // Buscar chofer por teléfono (últimos 10 dígitos, tolerante a @lid/@c.us)
            const db = await getPool();
            const bare10 = fromBare.replace(/\D/g,'').slice(-10);
            const [choferes] = await db.query('SELECT id, nombre, telefono FROM choferes WHERE telefono IS NOT NULL');
            console.log(`[WA-BOT] Buscando bare10=${bare10} entre ${choferes.length} choferes:`);
            choferes.forEach(c => {
              const t10 = String(c.telefono).replace(/\D/g,'').slice(-10);
              console.log(`  id=${c.id} tel="${c.telefono}" t10=${t10} match=${t10===bare10}`);
            });
            const chofer = choferes.find(c => String(c.telefono).replace(/\D/g,'').slice(-10) === bare10);
            if (!chofer) {
              console.log(`[WA-BOT] Imagen de número no registrado: ${fromBare} (bare10=${bare10})`);
              return;
            }
            console.log(`[WA-BOT] Chofer identificado: ${chofer.nombre} (id=${chofer.id}), analizando imagen...`);

            console.log(`[WA-COBRO] Imagen de ${chofer.nombre} — analizando con IA...`);

            // Analizar con IA
            let aiData = null;
            try {
              const { extractFacturaData } = require('./ai');
              aiData = await extractFacturaData(media.data, true, media.mimetype);
            } catch (aiErr) {
              console.warn('[WA-BOT] IA no pudo analizar imagen:', aiErr.message);
            }

            // Determinar si es transferencia válida
            // Parseo de monto argentino: "50.000" (miles con punto) → 50000; "1.250,50" → 1250.50
            const _rawMonto = String(aiData?.total || '').trim();
            const monto = (() => {
              let s = _rawMonto.replace(/[^0-9.,]/g, '');
              if (!s) return 0;
              // Si tiene coma → coma es decimal, puntos son miles: "1.250,50" → "1250.50"
              if (s.includes(',')) return parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0;
              // Solo puntos: si el punto separa exactamente 3 dígitos al final → miles: "50.000" → 50000
              if (/\.\d{3}$/.test(s)) return parseFloat(s.replace(/\./g, '')) || 0;
              return parseFloat(s) || 0;
            })();
            const nroOp = (aiData?.nro_operacion || '').trim();
            const codId = (aiData?.codigo_identificacion || '').trim();
            const tipoComp = (aiData?.tipo_comprobante || '').toLowerCase();
            const esTransferencia = aiData?.es_transferencia === 'true' || (
              monto > 0 && (
                nroOp || codId ||
                aiData?.cbu_destino || aiData?.alias_destino || aiData?.nombre_destino ||
                tipoComp.includes('transfer') || tipoComp.includes('comprobante') ||
                tipoComp.includes('pago') || tipoComp.includes('envío') || tipoComp.includes('envio')
              )
            );

            console.log(`[WA-COBRO] IA → monto=${monto} tipo="${aiData?.tipo_comprobante}" es_transferencia=${aiData?.es_transferencia} op=${nroOp}`);

            if (!esTransferencia || monto <= 0) {
              console.log(`[WA-BOT] Imagen de ${chofer.nombre} no reconocida como transferencia (monto=${monto} es_trf=${aiData?.es_transferencia})`);
              await message.reply(`Gracias ${chofer.nombre.split(' ')[0]} 👋`);
              return;
            }

            // Anti-duplicado
            if (nroOp) {
              const [dupRows] = await db.query(`SELECT id FROM pagos WHERE nro_transaccion = ? LIMIT 1`, [nroOp]);
              if (dupRows.length > 0) {
                await message.reply(`⚠️ Este comprobante ya fue registrado (Op. ${nroOp} → Cobro #${dupRows[0].id}).\nSi creés que es un error, contactá a la administración.`);
                return;
              }
            }

            // Guardar comprobante — PDF sin procesamiento, imagen con sharp
            const dir = path.join(__dirname, 'public', 'uploads', 'pagos', String(chofer.id));
            fs.mkdirSync(dir, { recursive: true });
            let fileBuffer = Buffer.from(media.data, 'base64');
            const ext = esPdf ? 'pdf' : 'jpg';
            const fname = `cobro_wa_${chofer.id}_${Date.now()}.${ext}`;
            if (!esPdf) {
              try {
                if (sharp) {
                  const meta = await sharp(fileBuffer).metadata();
                  const targetW = Math.max((meta.width || 0), 2400);
                  fileBuffer = await sharp(fileBuffer)
                    .rotate()
                    .resize({ width: targetW, withoutEnlargement: false })
                    .sharpen({ sigma: 1.2, m1: 0.5, m2: 2.5 })
                    .normalise()
                    .jpeg({ quality: 95, mozjpeg: true })
                    .toBuffer();
                }
              } catch(_se) { /* si sharp falla guardamos el original */ }
            }
            fs.writeFileSync(path.join(dir, fname), fileBuffer);
            const comprobante_url = `/uploads/pagos/${chofer.id}/${fname}`;

            // Buscar cuenta destino por CBU/alias
            let cuenta_id = null;
            const cbuDestino   = (aiData?.cbu_destino || '').replace(/\D/g, '');
            const aliasDestino = (aiData?.alias_destino || '').trim().toLowerCase();
            if (cbuDestino || aliasDestino) {
              const [cuentaRows] = await db.query(
                `SELECT id FROM cuentas WHERE REPLACE(cbu_cvu,' ','') = ? OR LOWER(alias) = ? LIMIT 1`,
                [cbuDestino || '__', aliasDestino || '__']
              );
              if (cuentaRows.length) cuenta_id = cuentaRows[0].id;
            }

            // Detalle legible
            const parteOrigen  = [aiData?.nombre_origen, aiData?.banco_origen].filter(Boolean).join(' / ');
            const parteDestino = [aiData?.nombre_destino, aliasDestino || aiData?.banco_destino].filter(Boolean).join(' / ');
            let detalle = `Transferencia WA${parteOrigen ? ' de ' + parteOrigen : ''}${parteDestino ? ' → ' + parteDestino : ''}`;
            if (nroOp) detalle += ` | Op: ${nroOp}`;
            if (codId) detalle += ` | ID: ${codId}`;

            // Fecha en hora local (sin toISOString que convierte a UTC)
            const _nowLocal = d => {
              const p = n => String(n).padStart(2,'0');
              return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
            };
            const fechaComp = aiData?.fecha_emision
              ? _nowLocal(new Date(aiData.fecha_emision))
              : _nowLocal(new Date());

            const [ins] = await db.query(
              `INSERT INTO pagos (chofer_id, cuenta_id, fecha, monto, tipo, concepto, medio_pago, detalle, comprobante_url, nro_transaccion)
               VALUES (?, ?, ?, ?, 'ingreso', 'Rendición', 'Transferencia', ?, ?, ?)`,
              [chofer.id, cuenta_id, fechaComp, monto, detalle, comprobante_url, nroOp || codId || null]
            );

            console.log(`[WA-COBRO] Cobro #${ins.insertId} $${monto} — ${chofer.nombre} (op=${nroOp || codId})`);

            // Auto-facturación provisoria: solo transferencias a seba.stasiu.buepp
            if (aliasDestino === 'seba.stasiu.buepp') {
              try {
                const waClient = waSessions.get('default').client;
                const chatId   = await _resolveWaChatId(waClient, FACTURITAS_NUMBER);
                const pagoId   = ins.insertId;
                _pendingFactura = { pagoId, ts: Date.now() };
                await db.query("UPDATE pagos SET factura_ref='pending' WHERE id=?", [pagoId]);
                const svcName = nroOp ? `Alquiler (Op. ${nroOp})` : `Alquiler (Cob. ${pagoId})`;
                const _wait = (ms = 12000) => new Promise(resolve => {
                  const h = msg => {
                    const b = msg.from.replace(/[@:].*/,'').replace(/[^\d]/g,'');
                    if (_isFacturitas(b)) { waClient.off('message', h); waClient.off('message_create', h); clearTimeout(t); resolve(msg); }
                  };
                  const t = setTimeout(() => { waClient.off('message', h); waClient.off('message_create', h); resolve(null); }, ms);
                  waClient.on('message', h);
                  waClient.on('message_create', h);
                });
                await waClient.sendMessage(chatId, 'Crear Factura Rápida');
                await _wait();
                await waClient.sendMessage(chatId, svcName);
                await _wait();
                await waClient.sendMessage(chatId, String(Math.round(monto)));
                await _wait();
                await waClient.sendMessage(chatId, 'Confirmar');
                console.log(`[WA-COBRO] Auto-facturación Facturitas iniciada para cobro #${pagoId}`);
              } catch (fErr) {
                console.error('[WA-COBRO] Auto-facturación falló:', fErr.message);
              }
            }

            const montoFmt = monto.toLocaleString('es-AR', { minimumFractionDigits: 0 });
            await message.reply(
              `✅ Transferencia registrada, ${chofer.nombre.split(' ')[0]}.\n` +
              `Monto: $${montoFmt}`
            );
          } catch (imgErr) {
            console.error('[WA-COBRO] Error procesando imagen:', imgErr.message);
            try { await message.reply('⚠️ Hubo un error procesando tu imagen. Intentá de nuevo en unos segundos.'); } catch(_) {}
          }
        }
      } catch (err) {
        console.error('[BOT] Error al procesar mensaje:', err.message);
      }
    });

    // Fallback: message_create captura mensajes que a veces no disparan 'message'
    // (ej: PDFs de cuentas business de WhatsApp)
    client.on('message_create', async (message) => {
      try {
        if (message.fromMe) return; // ignorar mensajes propios
        const fromBare = message.from.replace(/[@:].*/,'').replace(/[^\d]/g,'');
        if (_isFacturitas(fromBare) && message.hasMedia && message.type !== 'sticker') {
          console.log('[FACTURITAS][message_create] PDF detectado como fallback');
          _captureFacturaPDF(message).catch(e => console.error('[FACTURITAS] fallback error:', e.message));
        }
      } catch (_) {}
    });

  // ── Consulta de multas CABA vía bot de WhatsApp ──────────────────────────────
  const CABA_BOT_RAW = '5491150500147';  // número sin formato

  app.post('/api/multas/consultar-wa-caba', async (req, res) => {
    if (!botReadyStatus) return res.status(503).json({ message: 'WhatsApp no conectado' });
    const { patente } = req.body;
    if (!patente) return res.status(400).json({ message: 'patente requerida' });

    try {
      const client = waSessions.get('default').client;

      // Resolver el chatId real (getNumberId normaliza el número argentino, incluyendo @lid)
      _cabaBotChatId = await _resolveWaChatId(client, CABA_BOT_RAW);
      console.log(`[CABA-BOT] chatId resuelto: ${_cabaBotChatId}`);

      // Lee mensajes del bot desde la cola global (_cabaQueue) con polling cada 200ms.
      // maxMs: tiempo máximo esperando el primer mensaje.
      // silencioMs: silencio tras el último mensaje antes de resolver.
      const _drainQueue = (maxMs = 22000, silencioMs = 4000) => new Promise(resolve => {
        const msgs = [];
        let silenceTimer = null;
        let firstArrived = false;

        const finish = () => { clearTimeout(silenceTimer); clearInterval(iv); clearTimeout(mt); resolve(msgs); };
        const resetSilence = () => { clearTimeout(silenceTimer); silenceTimer = setTimeout(finish, silencioMs); };

        const iv = setInterval(() => {
          let got = false;
          while (_cabaQueue.length > 0) {
            msgs.push(_cabaQueue.shift().body);
            console.log(`[CABA-BOT] cola→ ${msgs[msgs.length-1].substring(0,60)}`);
            got = true;
          }
          if (got) {
            if (!firstArrived) { firstArrived = true; clearTimeout(mt); }
            resetSilence();
          }
        }, 200);

        const mt = setTimeout(finish, maxMs);
      });

      const patenteUpper = patente.trim().toUpperCase();

      // Limpiar cola antes de empezar (descartar mensajes viejos)
      _cabaQueue.length = 0;

      // Resetear estado del bot enviando "cancelar" por si hay conversación previa
      try { await client.sendMessage(_cabaBotChatId, 'cancelar'); await new Promise(r => setTimeout(r, 1500)); } catch(_) {}
      _cabaQueue.length = 0; // limpiar respuesta al cancelar

      // ── Paso 1: enviar "Revisar multas" y esperar respuesta ──
      await client.sendMessage(_cabaBotChatId, 'Revisar multas');
      const resp1 = await _drainQueue(22000, 4000);
      const texto1 = resp1.join('\n');
      console.log(`[CABA-BOT] Resp1 (${resp1.length} msgs): ${texto1.substring(0,300)}`);

      if (!resp1.length) return res.status(504).json({ message: 'El bot no respondió. Verificá que WhatsApp esté conectado.' });

      // ── Detectar si el bot ofrece opciones A/B/C ──
      let respuesta2 = patenteUpper;
      const opcionLines = texto1.match(/([A-E])\.\s*([A-Z0-9]+)/g) || [];
      for (const linea of opcionLines) {
        const m = linea.match(/([A-E])\.\s*([A-Z0-9]+)/);
        if (m && m[2].replace(/\s/g,'') === patenteUpper.replace(/\s/g,'')) {
          respuesta2 = m[1];
          console.log(`[CABA-BOT] Patente ${patenteUpper} → opción ${respuesta2}`);
          break;
        }
      }

      // ── Paso 2: responder con patente (o letra) y esperar resultado ──
      _cabaQueue.length = 0;
      await client.sendMessage(_cabaBotChatId, respuesta2);
      const resp2 = await _drainQueue(28000, 4500);
      const texto2 = resp2.join('\n');
      console.log(`[CABA-BOT] Resp2 (${resp2.length} msgs): ${texto2.substring(0,500)}`);

      // Cerrar conversación
      try { await client.sendMessage(_cabaBotChatId, 'cancelar'); } catch (_) {}

      if (!resp2.length) return res.status(504).json({ message: 'El bot no respondió con los datos de la patente.' });

      const resultado = _parsearRespuestaCABABot(texto2, patenteUpper);
      res.json({ ok: true, raw: texto2, ...resultado });

    } catch (err) {
      console.error('[CABA-BOT] Error:', err.message);
      res.status(500).json({ message: err.message });
    }
  });
}

function _parsearRespuestaCABABot(texto, patente) {
  if (!texto) return { multas: [], sin_multas: true };

  // "no tiene multas" / "no registra infracciones"
  if (/no\s+(tiene|registra|tenés|posee)\s+(multas?|infracciones?)/i.test(texto) ||
      /sin\s+infracciones?/i.test(texto)) {
    return { multas: [], sin_multas: true };
  }

  const multas = [];

  // Extraer bloque(s) de multa. Cada multa empieza con número tipo "1)" o "📄 1)"
  const bloques = texto.split(/(?=(?:📄\s*)?\d+\))/);

  for (const bloque of bloques) {
    if (!bloque.trim() || !/\d+\)/.test(bloque)) continue;

    // Descripción: primera línea después del número
    const descMatch = bloque.match(/\d+\)\s*(.+?)(?:\n|$)/);
    const descripcion = descMatch ? descMatch[1].trim() : '';

    // Fecha y hora: "DD-MM-YYYY a las HH:MM" o "DD/MM/YYYY"
    const fechaMatch = bloque.match(/(\d{2}[-/]\d{2}[-/]\d{4})\s+a\s+las\s+(\d{2}:\d{2})/);
    const fecha      = fechaMatch ? fechaMatch[1].replace(/-/g,'/') : null;
    const hora       = fechaMatch ? fechaMatch[2] : null;
    // Fecha ISO para DB (YYYY-MM-DD)
    const fechaISO   = fecha ? fecha.split('/').reverse().join('-') : null;

    // Lugar: línea que sigue a la fecha/hora, antes del monto
    const lugarMatch = bloque.match(/\d{2}:\d{2}\s*h?\s*[-–.]\s*(.+?)(?:\n|$)/);
    const lugar      = lugarMatch ? lugarMatch[1].trim() : null;

    // Puntos
    const puntosMatch = bloque.match(/Puntos?\s*(?:a\s*descontar\s*)?:\s*(\d+)/i);
    const puntos      = puntosMatch ? parseInt(puntosMatch[1]) : 0;

    // Monto: busca el monto vigente (puede estar precedido por tachado)
    // Patrón: "$71.249,25" o similar, el último número grande de la línea de monto
    const montoMatches = [...bloque.matchAll(/\$\s*([\d.,]+)/g)];
    let monto = null;
    if (montoMatches.length >= 2) {
      // Hay precio original (tachado) y precio con descuento → tomar el menor
      const montos = montoMatches.map(m => parseFloat(m[1].replace(/\./g,'').replace(',','.')));
      monto = Math.min(...montos);
    } else if (montoMatches.length === 1) {
      monto = parseFloat(montoMatches[0][1].replace(/\./g,'').replace(',','.'));
    }

    // Vencimiento del descuento: "hasta el DD-MM-YYYY"
    const vencMatch = bloque.match(/hasta\s+el\s+(\d{2}[-/]\d{2}[-/]\d{4})/i);
    const vencISO   = vencMatch
      ? vencMatch[1].replace(/-/g,'/').split('/').reverse().join('-')
      : null;

    // URL foto de la infracción
    const urlMatch = bloque.match(/https?:\/\/\S+/);
    const url_prueba = urlMatch ? urlMatch[0] : null;

    if (descripcion || monto) {
      multas.push({ descripcion, fecha_infraccion: fechaISO, hora_infraccion: hora,
                    lugar, puntos, monto, fecha_vencimiento: vencISO,
                    url_prueba, patente });
    }
  }

  // Resumen total
  const totalMatch = texto.match(/total\s+de\s+\$([\d.,]+)/i);
  const total = totalMatch ? parseFloat(totalMatch[1].replace(/\./g,'').replace(',','.')) : null;

  return { multas, sin_multas: multas.length === 0, total };
}

// ============================================================
// ============================================================
// AUTH
// ============================================================
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Email y contraseña requeridos' });
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM usuarios WHERE email = ? AND activo = 1', [email.toLowerCase()]);
    if (!rows.length) return res.status(401).json({ message: 'Credenciales incorrectas' });
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ message: 'Credenciales incorrectas' });
    // Cargar permisos
    const [perms] = await db.query('SELECT pantalla, puede_eliminar FROM permisos_pantallas WHERE usuario_id = ? AND permitido = 1', [user.id]);
    const puedeEliminar = user.rol === 'superadmin' || perms.some(p => p.puede_eliminar === 1);
    req.session.usuario = { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol };
    req.session.permisos = perms.map(p => p.pantalla);
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || null;
    await db.query('INSERT INTO auditoria (usuario_id, usuario_nombre, modulo, accion, descripcion, ip) VALUES (?,?,?,?,?,?)',
      [user.id, user.nombre, 'sistema', 'login', `Login exitoso`, ip]).catch(()=>{});
    res.json({ id: user.id, nombre: user.nombre, email: user.email, rol: user.rol, permisos: req.session.permisos, puede_eliminar: puedeEliminar });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session?.usuario) return res.status(401).json({ message: 'No autenticado' });
  try {
    const u = req.session.usuario;
    if (u.rol === 'superadmin') {
      return res.json({ ...u, permisos: req.session.permisos || [], puede_eliminar: true });
    }
    const db = await getPool();
    const [r] = await db.query('SELECT puede_eliminar FROM permisos_pantallas WHERE usuario_id=? AND puede_eliminar=1 LIMIT 1', [u.id]);
    res.json({ ...u, permisos: req.session.permisos || [], puede_eliminar: r.length > 0 });
  } catch { res.json({ ...req.session.usuario, permisos: req.session.permisos || [], puede_eliminar: false }); }
});

// ============================================================
// USUARIOS (solo SUPERADMIN y ADMIN)
// ============================================================
app.get('/api/usuarios', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT id, nombre, email, rol, activo, fecha_registro, celular, fecha_nacimiento, domicilio, lat, lng FROM usuarios ORDER BY nombre ASC');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Helper: guarda archivo DNI de usuario en disco
function _saveUsrDniFile(file, tipo, userId) {
  if (!file) return null;
  const dir = path.join(__dirname, 'public', 'uploads', 'usuarios', String(userId || 'tmp'));
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(file.originalname || file.fieldname || '.jpg') || '.jpg';
  const fname = `${tipo}_${Date.now()}${ext}`;
  fs.writeFileSync(path.join(dir, fname), file.buffer);
  return `/uploads/usuarios/${userId || 'tmp'}/${fname}`;
}

const usrDniUpload = multer({ storage: multer.memoryStorage() }).fields([
  { name: 'dni_frente', maxCount: 1 },
  { name: 'dni_dorso',  maxCount: 1 }
]);

app.post('/api/usuarios', usrDniUpload, async (req, res) => {
  const { nombre, email, password, rol, permisos, domicilio, entre_calles, codigo_postal, lat, lng, fecha_nacimiento, celular } = req.body;
  if (!nombre || !email || !password || !rol) return res.status(400).json({ message: 'Todos los campos son requeridos' });
  try {
    const db = await getPool();
    const [ex] = await db.query('SELECT id FROM usuarios WHERE email = ?', [email.toLowerCase()]);
    if (ex.length) return res.status(409).json({ message: 'Ya existe un usuario con ese email' });
    const hash = await bcrypt.hash(password, 10);
    const [r] = await db.query(
      'INSERT INTO usuarios (nombre, email, password_hash, rol, activo, domicilio, entre_calles, codigo_postal, lat, lng, fecha_nacimiento, celular) VALUES (?,?,?,?,1,?,?,?,?,?,?,?)',
      [nombre, email.toLowerCase(), hash, rol, domicilio||null, entre_calles||null, codigo_postal||null, lat||null, lng||null, fecha_nacimiento||null, celular||null]
    );
    const uid = r.insertId;
    // Guardar DNI si vienen
    const files = req.files || {};
    const dniFrente = files.dni_frente?.[0] ? _saveUsrDniFile(files.dni_frente[0], 'dni_frente', uid) : null;
    const dniDorso  = files.dni_dorso?.[0]  ? _saveUsrDniFile(files.dni_dorso[0],  'dni_dorso',  uid) : null;
    if (dniFrente || dniDorso) {
      await db.query('UPDATE usuarios SET dni_frente_url=?, dni_dorso_url=? WHERE id=?', [dniFrente, dniDorso, uid]);
    }
    const permsArr = typeof permisos === 'string' ? JSON.parse(permisos) : (permisos || []);
    const puedeElim = req.body.puede_eliminar == 1 || req.body.puede_eliminar === true ? 1 : 0;
    if (permsArr.length) {
      const vals = permsArr.map(p => [uid, p, 1, puedeElim]);
      await db.query('INSERT INTO permisos_pantallas (usuario_id, pantalla, permitido, puede_eliminar) VALUES ?', [vals]);
    }
    await registrarAuditoria(req, 'usuarios', 'crear', uid, `Usuario creado: ${nombre} (${email}) — rol: ${rol}`);
    res.status(201).json({ id: uid });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put('/api/usuarios/:id', usrDniUpload, async (req, res) => {
  const { nombre, email, password, rol, activo, permisos, domicilio, entre_calles, codigo_postal, lat, lng, fecha_nacimiento, celular } = req.body;
  try {
    const db = await getPool();
    const files = req.files || {};
    const dniFrente = files.dni_frente?.[0] ? _saveUsrDniFile(files.dni_frente[0], 'dni_frente', req.params.id) : null;
    const dniDorso  = files.dni_dorso?.[0]  ? _saveUsrDniFile(files.dni_dorso[0],  'dni_dorso',  req.params.id) : null;
    let dniFields = ''; const dniVals = [];
    if (dniFrente) { dniFields += ', dni_frente_url=?'; dniVals.push(dniFrente); }
    if (dniDorso)  { dniFields += ', dni_dorso_url=?';  dniVals.push(dniDorso); }
    const extraFields = `, domicilio=?, entre_calles=?, codigo_postal=?, lat=?, lng=?, fecha_nacimiento=?, celular=?${dniFields}`;
    const extraVals = [domicilio||null, entre_calles||null, codigo_postal||null, lat||null, lng||null, fecha_nacimiento||null, celular||null, ...dniVals];
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await db.query(`UPDATE usuarios SET nombre=?, email=?, password_hash=?, rol=?, activo=?${extraFields} WHERE id=?`,
        [nombre, email.toLowerCase(), hash, rol, activo??1, ...extraVals, req.params.id]);
    } else {
      await db.query(`UPDATE usuarios SET nombre=?, email=?, rol=?, activo=?${extraFields} WHERE id=?`,
        [nombre, email.toLowerCase(), rol, activo??1, ...extraVals, req.params.id]);
    }
    const permsArr = typeof permisos === 'string' ? JSON.parse(permisos) : (permisos || null);
    const puedeElim = req.body.puede_eliminar == 1 || req.body.puede_eliminar === true ? 1 : 0;
    if (permsArr) {
      await db.query('DELETE FROM permisos_pantallas WHERE usuario_id = ?', [req.params.id]);
      if (permsArr.length) {
        const vals = permsArr.map(p => [req.params.id, p, 1, puedeElim]);
        await db.query('INSERT INTO permisos_pantallas (usuario_id, pantalla, permitido, puede_eliminar) VALUES ?', [vals]);
      }
    }
    await registrarAuditoria(req, 'usuarios', 'editar', req.params.id, `Usuario actualizado: ${nombre}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Productos (endpoints con memUpload se registran más abajo)
app.get('/api/productos', async (req, res) => {
  try { const db = await getPool(); const [r] = await db.query('SELECT * FROM productos ORDER BY nombre ASC'); res.json(r); }
  catch(err) { res.status(500).json({ message: err.message }); }
});
app.post('/api/productos', memUpload.single('foto'), async (req, res) => {
  const { nombre, descripcion, precio_venta, codigo_barras, stock_central } = req.body;
  if (!nombre) return res.status(400).json({ message: 'Nombre requerido' });
  let foto_url = null;
  if (req.file) {
    const pathM = require('path'); const fs = require('fs');
    const dir = require('path').join(__dirname, 'public', 'uploads', 'productos');
    fs.mkdirSync(dir, { recursive: true });
    const fname = `prod_${Date.now()}${pathM.extname(req.file.originalname)}`;
    fs.writeFileSync(pathM.join(dir, fname), req.file.buffer);
    foto_url = `/uploads/productos/${fname}`;
  }
  try {
    const db = await getPool();
    const [r] = await db.query('INSERT INTO productos (nombre, descripcion, precio_venta, foto_url, codigo_barras, stock_central) VALUES (?,?,?,?,?,?)',
      [nombre, descripcion||null, precio_venta||null, foto_url, codigo_barras||null, stock_central||0]);
    await registrarAuditoria(req, 'stock', 'producto-crear', r.insertId, `Producto creado: ${nombre}`);
    res.status(201).json({ id: r.insertId });
  } catch(err) { res.status(500).json({ message: err.message }); }
});
app.put('/api/productos/:id', memUpload.single('foto'), async (req, res) => {
  const { nombre, descripcion, precio_venta, codigo_barras, stock_central, activo } = req.body;
  try {
    const db = await getPool();
    let foto_url = req.body.foto_url_existing || null;
    if (req.file) {
      const pathM = require('path'); const fs = require('fs');
      const dir = pathM.join(__dirname, 'public', 'uploads', 'productos');
      fs.mkdirSync(dir, { recursive: true });
      const fname = `prod_${Date.now()}${pathM.extname(req.file.originalname)}`;
      fs.writeFileSync(pathM.join(dir, fname), req.file.buffer);
      foto_url = `/uploads/productos/${fname}`;
    }
    await db.query('UPDATE productos SET nombre=?,descripcion=?,precio_venta=?,foto_url=?,codigo_barras=?,stock_central=?,activo=? WHERE id=?',
      [nombre, descripcion||null, precio_venta||null, foto_url, codigo_barras||null, stock_central||0, activo??1, req.params.id]);
    await registrarAuditoria(req, 'stock', 'producto-editar', req.params.id, `Producto actualizado: ${nombre}`);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ message: err.message }); }
});
app.delete('/api/productos/:id', async (req, res) => {
  if (!await checkPuedeEliminar(req, res)) return;
  try {
    const db = await getPool();
    const [pr] = await db.query('SELECT nombre FROM productos WHERE id=?', [req.params.id]);
    await db.query('UPDATE productos SET activo=0 WHERE id=?', [req.params.id]);
    await registrarAuditoria(req, 'stock', 'desactivar', req.params.id, `Producto desactivado: ${pr[0]?.nombre||req.params.id}`);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ message: err.message }); }
});

// ── Entregas de stock ────────────────────────────────────────────
app.get('/api/stock-entregas', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query(`
      SELECT se.*, c.nombre as chofer_nombre, v.patente
      FROM stock_entregas se
      JOIN choferes c ON se.chofer_id = c.id
      LEFT JOIN vehiculos v ON se.vehiculo_id = v.id
      ORDER BY se.fecha_entrega DESC`);
    res.json(rows);
  } catch(err) { res.status(500).json({ message: err.message }); }
});
app.get('/api/stock-entregas/:id/items', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query(`SELECT sei.*, p.nombre as producto_nombre, p.precio_venta FROM stock_entrega_items sei JOIN productos p ON sei.producto_id=p.id WHERE sei.entrega_id=?`, [req.params.id]);
    res.json(rows);
  } catch(err) { res.status(500).json({ message: err.message }); }
});
app.post('/api/stock-entregas', async (req, res) => {
  const { chofer_id, vehiculo_id, fecha_entrega, items, notas } = req.body;
  if (!chofer_id || !fecha_entrega || !items?.length) return res.status(400).json({ message: 'Datos incompletos' });
  try {
    const db = await getPool();
    const [r] = await db.query('INSERT INTO stock_entregas (chofer_id, vehiculo_id, fecha_entrega, notas) VALUES (?,?,?,?)',
      [chofer_id, vehiculo_id||null, fecha_entrega, notas||null]);
    const eid = r.insertId;
    for (const item of items) {
      await db.query('INSERT INTO stock_entrega_items (entrega_id, producto_id, cantidad_entregada) VALUES (?,?,?)',
        [eid, item.producto_id, item.cantidad]);
      // Descontar del stock central
      await db.query('UPDATE productos SET stock_central = stock_central - ? WHERE id=?', [item.cantidad, item.producto_id]);
    }
    await registrarAuditoria(req, 'stock', 'crear', eid, `Entrega de stock registrada: chofer_id=${chofer_id}, ${items.length} ítem(s), fecha ${fecha_entrega}`);
    res.status(201).json({ id: eid });
  } catch(err) { res.status(500).json({ message: err.message }); }
});
// Registrar remanente y calcular diferencia
app.put('/api/stock-entregas/:id/remanente', async (req, res) => {
  const { items } = req.body; // [{item_id, cantidad_remanente}]
  try {
    const db = await getPool();
    for (const item of items) {
      await db.query('UPDATE stock_entrega_items SET cantidad_remanente=? WHERE id=?', [item.cantidad_remanente, item.item_id]);
    }
    await registrarAuditoria(req, 'stock', 'remanente-editar', req.params.id, `Remanente actualizado para entrega_id=${req.params.id}: ${items.length} ítem(s)`);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ message: err.message }); }
});

// ── Rendiciones — ahora proviene de pagos tipo='ingreso' ─────────
// ── RENDICIONES (vista de cobranzas — lee de pagos/pago_conceptos) ───────────
app.get('/api/rendiciones', async (req, res) => {
  try {
    const db = await getPool();
    const { desde, hasta, cuenta_id, chofer_id } = req.query;
    const conditions = ["p.tipo = 'ingreso'"];
    const params = [];
    if (desde)     { conditions.push('p.fecha >= ?');            params.push(desde); }
    if (hasta)     { conditions.push("p.fecha <= ?");            params.push(hasta + ' 23:59:59'); }
    if (cuenta_id === 'efectivo') { conditions.push("(p.cuenta_id IS NULL OR p.medio_pago = 'Efectivo')"); }
    else if (cuenta_id) { conditions.push('p.cuenta_id = ?'); params.push(cuenta_id); }
    if (chofer_id) { conditions.push('p.chofer_id = ?');         params.push(chofer_id); }
    const where = conditions.join(' AND ');
    const [rows] = await db.query(`
      SELECT p.id, p.fecha, p.monto AS monto_total, p.medio_pago,
             p.nro_transaccion, p.comprobante_url, p.detalle AS notas,
             p.factura_url, p.factura_ref,
             ch.nombre AS chofer_nombre,
             ch.id AS chofer_id, ch.modalidad AS chofer_modalidad,
             NULL AS patente,
             'pagos' AS _origen,
             cu.alias AS cuenta_alias, cu.id AS cuenta_id_val,
             COALESCE((SELECT SUM(pc.monto) FROM pago_conceptos pc WHERE pc.pago_id = p.id), 0) AS imputado_total
      FROM pagos p
      JOIN choferes ch ON p.chofer_id = ch.id
      LEFT JOIN cuentas cu ON p.cuenta_id = cu.id
      WHERE ${where}
      ORDER BY p.fecha DESC`, params);
    res.json(rows);
  } catch(err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/rendiciones/stats-conceptos', async (req, res) => {
  try {
    const db = await getPool();
    const { desde, hasta, chofer_id } = req.query;
    const conds = ["p.tipo = 'ingreso'"], params = [];
    if (desde)     { conds.push('p.fecha >= ?');     params.push(desde); }
    if (hasta)     { conds.push("p.fecha <= ?");     params.push(hasta + ' 23:59:59'); }
    if (chofer_id) { conds.push('p.chofer_id = ?');  params.push(chofer_id); }
    const where = conds.join(' AND ');
    const [rows] = await db.query(`
      SELECT pc.concepto, SUM(pc.monto) AS total
      FROM pago_conceptos pc
      JOIN pagos p ON pc.pago_id = p.id
      WHERE ${where}
      GROUP BY pc.concepto
      ORDER BY total DESC`, params);
    res.json(rows);
  } catch(err) { res.status(500).json({ message: err.message }); }
});

// ── PERSONAS ────────────────────────────────────────────────────────────────

app.get('/api/personas', async (req, res) => {
  try {
    const db = await getPool();
    const q = req.query.q;
    let where = '';
    const params = [];
    if (q) {
      where = ` WHERE CONCAT(p.nombre,' ',p.apellido) LIKE ? OR p.dni LIKE ? OR p.cuil LIKE ?`;
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    const [rows] = await db.query(
      `SELECT p.id, p.nombre, p.apellido, p.dni, p.cuil, p.email, p.celular, p.domicilio, p.codigo_postal, p.activo,
              p.fecha_registro, p.updated_at,
              uc.nombre AS created_by_nombre, uu.nombre AS updated_by_nombre
       FROM personas p
       LEFT JOIN usuarios uc ON p.created_by = uc.id
       LEFT JOIN usuarios uu ON p.updated_by = uu.id
       ${where} ORDER BY p.apellido, p.nombre`, params);

    // Adjuntar vehículos de cada persona
    const ids = rows.map(r => r.id);
    let vehiculosByPersona = {};
    if (ids.length) {
      const [vrows2] = await db.query(
        `SELECT v.id, v.patente, v.activo, v.persona_id,
                m.nombre AS modelo_nombre, mr.nombre AS marca_nombre, v.color
         FROM vehiculos v
         LEFT JOIN modelos m  ON v.modelo_id  = m.id
         LEFT JOIN marcas  mr ON m.marca_id   = mr.id
         WHERE v.persona_id IN (?)`, [ids]);
      vrows2.forEach(v => {
        if (!vehiculosByPersona[v.persona_id]) vehiculosByPersona[v.persona_id] = [];
        vehiculosByPersona[v.persona_id].push({
          id: v.id, patente: v.patente, activo: v.activo,
          marca: v.marca_nombre, modelo: v.modelo_nombre, color: v.color
        });
      });
    }

    const result = rows.map(r => ({ ...r, vehiculos: vehiculosByPersona[r.id] || [] }));
    res.json(result);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/personas/:id', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM personas WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'No encontrado' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/personas', async (req, res) => {
  const { nombre, apellido, dni, cuil, email, celular, domicilio, localidad, referencia, entre_calles, codigo_postal, lat, lng } = req.body;
  if (!nombre || !apellido) return res.status(400).json({ message: 'Nombre y apellido son requeridos' });
  try {
    const db = await getPool();
    if (dni) {
      const [dup] = await db.query('SELECT id FROM personas WHERE dni=?', [dni]);
      if (dup.length) return res.status(409).json({ message: 'Ya existe una persona con ese DNI' });
    }
    const userId = req.session?.usuario?.id || null;
    const [r] = await db.query(
      `INSERT INTO personas (nombre,apellido,dni,cuil,email,celular,telegram_chat_id,domicilio,localidad,referencia,entre_calles,codigo_postal,lat,lng,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [nombre, apellido, dni||null, cuil||null, email||null, celular||null, req.body.telegram_chat_id||null, domicilio||null, localidad||null, referencia||null, entre_calles||null, codigo_postal||null, lat||null, lng||null, userId]
    );
    await registrarAuditoria(req, 'personas', 'crear', r.insertId, `Nueva persona: ${nombre} ${apellido}`);
    res.status(201).json({ id: r.insertId });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put('/api/personas/:id', async (req, res) => {
  const { nombre, apellido, dni, cuil, email, celular, telegram_chat_id, domicilio, localidad, referencia, entre_calles, codigo_postal, lat, lng, activo } = req.body;
  if (!nombre || !apellido) return res.status(400).json({ message: 'Nombre y apellido son requeridos' });
  try {
    const db = await getPool();
    if (dni) {
      const [dup] = await db.query('SELECT id FROM personas WHERE dni=? AND id<>?', [dni, req.params.id]);
      if (dup.length) return res.status(409).json({ message: 'Ya existe otra persona con ese DNI' });
    }
    const userId = req.session?.usuario?.id || null;
    await db.query(
      `UPDATE personas SET nombre=?,apellido=?,dni=?,cuil=?,email=?,celular=?,telegram_chat_id=?,domicilio=?,localidad=?,referencia=?,entre_calles=?,codigo_postal=?,lat=?,lng=?,activo=?,updated_by=? WHERE id=?`,
      [nombre, apellido, dni||null, cuil||null, email||null, celular||null, telegram_chat_id||null, domicilio||null, localidad||null, referencia||null, entre_calles||null, codigo_postal||null, lat||null, lng||null, activo??1, userId, req.params.id]
    );
    await registrarAuditoria(req, 'personas', 'editar', req.params.id, `Persona editada: ${nombre} ${apellido}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/personas/:id', async (req, res) => {
  const rol = req.session?.usuario?.rol;
  if (rol !== 'superadmin') return res.status(403).json({ message: 'Sin permiso' });
  try {
    const db = await getPool();
    // Desvincular en lugar de bloquear por FK
    await db.query('UPDATE vehiculos SET persona_id=NULL WHERE persona_id=?', [req.params.id]);
    await db.query('UPDATE cuentas   SET persona_id=NULL WHERE persona_id=?', [req.params.id]);
    const [r] = await db.query('DELETE FROM personas WHERE id=?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'No encontrado' });
    await registrarAuditoria(req, 'personas', 'eliminar', req.params.id, 'Persona eliminada');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Foto de persona
app.post('/api/personas/:id/foto', memUpload.single('foto'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Sin archivo' });
  try {
    const db = await getPool();
    const pid = req.params.id;
    const dir = path.join(__dirname, 'public', 'uploads', 'personas', pid);
    fs.mkdirSync(dir, { recursive: true });
    const fname = 'foto' + path.extname(req.file.originalname || '.jpg');
    fs.writeFileSync(path.join(dir, fname), req.file.buffer);
    const foto_url = `/uploads/personas/${pid}/${fname}`;
    await db.query('UPDATE personas SET foto_url=? WHERE id=?', [foto_url, pid]);
    await registrarAuditoria(req, 'personas', 'foto-subir', pid, `Foto de perfil actualizada para persona_id=${pid}`);
    res.json({ ok: true, foto_url });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Vehículos de una persona
app.get('/api/personas/:id/vehiculos', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query(
      `SELECT v.id, v.patente, v.marca, v.modelo, v.\`año\`, v.color, v.activo
       FROM vehiculos v
       WHERE v.persona_id = ?
       ORDER BY v.activo DESC, v.patente`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Cuentas bancarias de una persona
app.get('/api/personas/:id/cuentas', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query(
      `SELECT c.*, b.nombre AS banco_nombre, b.logo_emoji AS banco_emoji
       FROM cuentas c
       LEFT JOIN bancos b ON c.banco_id = b.id
       WHERE c.persona_id = ?
       ORDER BY b.nombre, c.alias`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Services de los vehículos de una persona
app.get('/api/personas/:id/services', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query(
      `SELECT s.*, v.patente, v.marca, v.modelo,
              p.nombre AS proveedor_nombre
       FROM services s
       JOIN vehiculos v ON v.id = s.vehiculo_id
       LEFT JOIN proveedores p ON p.id = s.proveedor_id
       WHERE v.persona_id = ?
       ORDER BY s.fecha DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Importar propietarios desde cuentas y vehículos existentes (dedup por DNI)
app.post('/api/personas/seed', async (req, res) => {
  try {
    const db = await getPool();

    // 1. Recolectar candidatos de CUENTAS (nombre + apellido separados, dni)
    const [cuentas] = await db.query(`
      SELECT id, nombre, apellido, dni, cuil FROM cuentas
      WHERE dni IS NOT NULL AND dni <> ''
    `);

    // 2. Recolectar candidatos de VEHICULOS (titular_nombre = nombre completo, titular_dni)
    const [vehiculos] = await db.query(`
      SELECT id, titular_nombre, titular_dni, titular_cuit,
             titular_email, titular_celular, titular_domicilio,
             titular_codigo_postal, titular_lat, titular_lng
      FROM vehiculos
      WHERE titular_dni IS NOT NULL AND titular_dni <> ''
    `);

    // Mapa DNI → persona acumulada (cuenta tiene prioridad para nombre/apellido)
    const byDni = new Map();

    for (const c of cuentas) {
      const dni = String(c.dni).trim();
      if (!dni) continue;
      byDni.set(dni, {
        nombre:        (c.nombre  || '').trim(),
        apellido:      (c.apellido|| '').trim(),
        dni,
        cuil:          c.cuil || null,
        email:         null,
        celular:       null,
        domicilio:     null,
        codigo_postal: null,
        lat:           null,
        lng:           null,
        _cuentaIds:    [c.id],
        _vehiculoIds:  [],
      });
    }

    for (const v of vehiculos) {
      const dni = String(v.titular_dni).trim();
      if (!dni) continue;
      // Intentar separar "APELLIDO NOMBRE" → último token = nombre, resto = apellido
      const partes = (v.titular_nombre || '').trim().split(/\s+/);
      const nombreVeh   = partes.length > 1 ? partes.slice(-1).join(' ')  : '';
      const apellidoVeh = partes.length > 1 ? partes.slice(0,-1).join(' '): partes[0] || '';

      if (byDni.has(dni)) {
        // Ya existe (de cuentas): enriquecer con datos del vehículo si faltan
        const p = byDni.get(dni);
        if (!p.cuil)          p.cuil          = v.titular_cuit  || null;
        if (!p.email)         p.email         = v.titular_email  || null;
        if (!p.celular)       p.celular        = v.titular_celular|| null;
        if (!p.domicilio)     p.domicilio      = v.titular_domicilio || null;
        if (!p.codigo_postal) p.codigo_postal  = v.titular_codigo_postal || null;
        if (!p.lat)           p.lat            = v.titular_lat   || null;
        if (!p.lng)           p.lng            = v.titular_lng   || null;
        p._vehiculoIds.push(v.id);
      } else {
        byDni.set(dni, {
          nombre:        nombreVeh,
          apellido:      apellidoVeh,
          dni,
          cuil:          v.titular_cuit          || null,
          email:         v.titular_email          || null,
          celular:       v.titular_celular        || null,
          domicilio:     v.titular_domicilio      || null,
          codigo_postal: v.titular_codigo_postal  || null,
          lat:           v.titular_lat            || null,
          lng:           v.titular_lng            || null,
          _cuentaIds:    [],
          _vehiculoIds:  [v.id],
        });
      }
    }

    let insertados = 0, actualizados = 0, vinculados = 0;

    for (const p of byDni.values()) {
      const apellido = p.apellido || p.nombre || '(sin apellido)';
      const nombre   = p.apellido ? p.nombre : '';

      // Upsert persona por DNI
      const [existing] = await db.query('SELECT id FROM personas WHERE dni=?', [p.dni]);
      let personaId;

      if (existing.length) {
        personaId = existing[0].id;
        // Enriquecer campos vacíos
        await db.query(`
          UPDATE personas SET
            nombre        = COALESCE(NULLIF(nombre,''),       ?),
            apellido      = COALESCE(NULLIF(apellido,''),     ?),
            cuil          = COALESCE(cuil,          ?),
            email         = COALESCE(email,         ?),
            celular       = COALESCE(celular,       ?),
            domicilio     = COALESCE(domicilio,     ?),
            codigo_postal = COALESCE(codigo_postal, ?),
            lat           = COALESCE(lat,           ?),
            lng           = COALESCE(lng,           ?)
          WHERE id=?`,
          [nombre, apellido, p.cuil, p.email, p.celular, p.domicilio,
           p.codigo_postal, p.lat, p.lng, personaId]);
        actualizados++;
      } else {
        const [r] = await db.query(`
          INSERT INTO personas (nombre, apellido, dni, cuil, email, celular, domicilio, codigo_postal, lat, lng)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [nombre, apellido, p.dni, p.cuil, p.email, p.celular,
           p.domicilio, p.codigo_postal, p.lat, p.lng]);
        personaId = r.insertId;
        insertados++;
      }

      // Vincular FK hacia atrás
      for (const cId of p._cuentaIds) {
        await db.query('UPDATE cuentas   SET persona_id=? WHERE id=? AND persona_id IS NULL', [personaId, cId]);
        vinculados++;
      }
      for (const vId of p._vehiculoIds) {
        await db.query('UPDATE vehiculos SET persona_id=? WHERE id=? AND persona_id IS NULL', [personaId, vId]);
        vinculados++;
      }
    }

    await registrarAuditoria(req, 'personas', 'seed', null,
      `Seed: ${insertados} insertados, ${actualizados} enriquecidos, ${vinculados} vínculos`);

    res.json({ ok: true, insertados, actualizados, vinculados, total: byDni.size });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PEAJES ──────────────────────────────────────────────────────────────────

app.get('/api/peajes', async (req, res) => {
  try {
    const db = await getPool();
    const { desde, hasta, patente, autopista, chofer_id } = req.query;
    let where = [], vals = [];
    if (desde)     { where.push('p.fecha_hora >= ?'); vals.push(desde + ' 00:00:00'); }
    if (hasta)     { where.push('p.fecha_hora <= ?'); vals.push(hasta + ' 23:59:59'); }
    if (patente)   { where.push('p.patente = ?');     vals.push(patente); }
    if (autopista) { where.push('p.autopista LIKE ?'); vals.push('%' + autopista + '%'); }
    // Los filtros de chofer se aplican con HAVING después del GROUP BY (ver sql abajo)
    const having = chofer_id === 'sin_asignar' ? 'HAVING chofer_id IS NULL'
                 : chofer_id                   ? `HAVING chofer_id = ${parseInt(chofer_id)}`
                 : '';
    // Vincula por patente del peaje → vehiculo → turno (inicio y fin requeridos)
    const sql = `SELECT p.*, ch.id AS chofer_id, ch.nombre AS chofer_nombre
                 FROM peajes p
                 LEFT JOIN vehiculos v ON v.patente COLLATE utf8mb4_general_ci = p.patente COLLATE utf8mb4_general_ci
                 LEFT JOIN turnos t ON t.vehiculo_id = v.id
                   AND t.fecha_fin IS NOT NULL
                   AND t.fecha_inicio <= p.fecha_hora
                   AND t.fecha_fin >= p.fecha_hora
                 LEFT JOIN choferes ch ON ch.id = t.chofer_id
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 GROUP BY p.id
                 ${having}
                 ORDER BY p.fecha_hora DESC`;
    const [rows] = await db.query(sql, vals);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/peajes/bulk', async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || !rows.length)
    return res.status(400).json({ message: 'No hay datos para importar' });
  try {
    const db = await getPool();
    // Obtener patentes conocidas para asociar vehiculo_id
    const [vehiculos] = await db.query('SELECT id, patente FROM vehiculos');
    const patenteMap = {};
    vehiculos.forEach(v => { patenteMap[v.patente.toUpperCase()] = v.id; });

    const userId = req.session?.usuario?.id || null;
    let inserted = 0, duplicates = 0, errors = 0;
    for (const r of rows) {
      try {
        const vid = patenteMap[r.patente?.toUpperCase()] || null;
        await db.query(
          `INSERT INTO peajes (autopista, barrera, patente, fecha_hora, importe, vehiculo_id, cargado_por)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [r.autopista, r.barrera||'', r.patente||'', r.fecha_hora, r.importe, vid, userId]
        );
        inserted++;
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') duplicates++;
        else { errors++; console.error('[PEAJES] error row:', r, e.message); }
      }
    }
    await registrarAuditoria(req, 'peajes', 'importar', null, `Bulk import: ${inserted} insertados, ${duplicates} duplicados`);
    res.json({ inserted, duplicates, errors });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Deduplicar peajes: elimina el registro con barrera más corta cuando hay duplicados exactos
app.post('/api/peajes/deduplicar', requireAuth, async (req, res) => {
  if (req.session?.usuario?.rol !== 'superadmin') return res.status(403).json({ message: 'Sin permiso' });
  try {
    const db = await getPool();
    // Busca grupos con misma autopista, patente, fecha_hora e importe
    const [grupos] = await db.query(`
      SELECT autopista, patente, fecha_hora, importe, COUNT(*) as cnt
      FROM peajes
      GROUP BY autopista, patente, fecha_hora, importe
      HAVING cnt > 1
    `);
    let eliminados = 0;
    for (const g of grupos) {
      const [filas] = await db.query(
        `SELECT id, barrera FROM peajes
         WHERE autopista=? AND patente=? AND fecha_hora=? AND importe=?
         ORDER BY LENGTH(barrera) DESC`,
        [g.autopista, g.patente, g.fecha_hora, g.importe]
      );
      // Mantener el primero (barrera más larga), eliminar el resto
      const idsAEliminar = filas.slice(1).map(f => f.id);
      if (idsAEliminar.length) {
        await db.query(`DELETE FROM peajes WHERE id IN (?)`, [idsAEliminar]);
        eliminados += idsAEliminar.length;
      }
    }
    await registrarAuditoria(req, 'peajes', 'eliminar', null, `Deduplicación: ${eliminados} registros eliminados`);
    res.json({ eliminados, grupos: grupos.length });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/peajes/:id', requireAuth, async (req, res) => {
  if (req.session?.usuario?.rol !== 'superadmin') return res.status(403).json({ message: 'Sin permiso' });
  try {
    const db = await getPool();
    await db.query('DELETE FROM peajes WHERE id=?', [req.params.id]);
    await registrarAuditoria(req, 'peajes', 'eliminar', req.params.id, `Peaje eliminado: id=${req.params.id}`);
    res.json({ message: 'Eliminado' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Importar Excel de peajes (archivo subido)
app.post('/api/peajes/import-excel', memUpload.single('file'), requireAuth, async (req, res) => {
  if (req.session?.usuario?.rol !== 'superadmin') return res.status(403).json({ message: 'Sin permiso' });
  if (!req.file) return res.status(400).json({ message: 'Archivo requerido' });
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.read(req.file.buffer, { cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { defval: null });

    const db = await getPool();
    const [vehiculos] = await db.query('SELECT id, patente FROM vehiculos');
    const patenteMap = {};
    vehiculos.forEach(v => { patenteMap[v.patente.toUpperCase()] = v.id; });

    const userId = req.session?.usuario?.id || null;
    let inserted = 0, duplicates = 0, errors = 0;
    for (const r of data) {
      try {
        const autopista = r['Autopista'] || r['autopista'];
        const patente   = r['Patente']   || r['patente'];
        let   fechaHora = r['Fecha Hora Paso'] || r['fecha_hora'];
        let   importe   = r['Importe']   || r['importe'];

        if (!autopista || !patente || !fechaHora) continue;

        // Normalizar fecha
        if (fechaHora instanceof Date) {
          const d = fechaHora;
          fechaHora = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:00`;
        } else if (typeof fechaHora === 'string') {
          // DD-MM-YYYY HH:MM
          const m = fechaHora.match(/(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})/);
          if (m) fechaHora = `${m[3]}-${m[2]}-${m[1]} ${m[4]}:${m[5]}:00`;
        } else if (typeof fechaHora === 'number') {
          // Serial de Excel
          const d = new Date((fechaHora - 25569) * 86400 * 1000);
          fechaHora = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:00`;
        }

        // Normalizar importe
        if (typeof importe === 'string') {
          importe = parseFloat(importe.replace(/[$\s.]/g,'').replace(',','.')) || 0;
        }
        importe = parseFloat(importe) || 0;

        const vid = patenteMap[String(patente).toUpperCase()] || null;
        await db.query(
          `INSERT INTO peajes (autopista, patente, fecha_hora, importe, vehiculo_id, cargado_por) VALUES (?, ?, ?, ?, ?, ?)`,
          [String(autopista).trim(), String(patente).trim().toUpperCase(), fechaHora, importe, vid, userId]
        );
        inserted++;
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') duplicates++;
        else { errors++; }
      }
    }
    await registrarAuditoria(req, 'peajes', 'importar-excel', null, `Excel import: ${inserted} insertados, ${duplicates} duplicados, archivo: ${req.file.originalname}`);
    res.json({ inserted, duplicates, errors, total: data.length });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── AFIP: Consulta de contribuyente por CUIT (Padrón A5 — autorizado) ────────
// ══ AFIP / ARCA — Contribuyentes (multi-CUIT) ════════════════════════════════

const TIPOS_CBTE = {1:'Factura A',2:'Nota Cré. A',3:'Nota Déb. A',6:'Factura B',7:'Nota Cré. B',
  8:'Nota Déb. B',11:'Factura C',12:'Nota Cré. C',13:'Nota Déb. C',51:'Factura M',
  81:'Tique Factura A',82:'Tique Factura B',201:'Factura de Crédito A',206:'Factura de Crédito B'};

// ── CRUD contribuyentes ───────────────────────────────────────────────────────
app.get('/api/afip/contribuyentes', requireAuth, async (req, res) => {
  const db = await getPool();
  const [rows] = await db.query(
    `SELECT id,cuit,nombre,punto_venta,production,cert_vence,activo,notas,
            IF(cert_pem IS NOT NULL,1,0) AS tiene_cert,
            IF(key_pem  IS NOT NULL,1,0) AS tiene_key
     FROM afip_contribuyentes ORDER BY nombre`);
  res.json(rows);
});

app.post('/api/afip/contribuyentes', requireAuth, async (req, res) => {
  try {
    const { cuit, nombre, punto_venta = 1, production = 0, notas, concepto_base } = req.body;
    if (!cuit || !nombre) return res.status(400).json({ message: 'cuit y nombre requeridos' });
    const db = await getPool();
    const [r] = await db.query(
      `INSERT INTO afip_contribuyentes (cuit,nombre,punto_venta,production,notas,concepto_base) VALUES (?,?,?,?,?,?)`,
      [cuit, nombre, punto_venta, production ? 1 : 0, notas || null, concepto_base || null]);
    res.json({ ok: true, id: r.insertId });
  } catch(err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Ya existe un contribuyente con ese CUIT' });
    res.status(500).json({ message: err.message });
  }
});

app.put('/api/afip/contribuyentes/:id', requireAuth, async (req, res) => {
  try {
    const { nombre, punto_venta, production, notas, activo, wscdc_url, concepto_base } = req.body;
    const db = await getPool();
    await db.query(
      `UPDATE afip_contribuyentes SET nombre=?,punto_venta=?,production=?,notas=?,activo=?,wscdc_url=?,concepto_base=? WHERE id=?`,
      [nombre, punto_venta, production ? 1 : 0, notas || null, activo !== undefined ? activo : 1, wscdc_url || null, concepto_base || null, req.params.id]);
    const { invalidateAfipInstance } = require('./afip-service');
    const [[c]] = await db.query('SELECT cuit FROM afip_contribuyentes WHERE id=?', [req.params.id]);
    if (c) invalidateAfipInstance(c.cuit);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/afip/contribuyentes/:id', requireAuth, async (req, res) => {
  const db = await getPool();
  await db.query('UPDATE afip_contribuyentes SET activo=0 WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// Subir cert (.crt) o key (.key) de un contribuyente
app.post('/api/afip/contribuyentes/:id/cert', requireAuth, memUpload.single('file'), async (req, res) => {
  try {
    const tipo = req.query.tipo; // 'cert' | 'key'
    if (!['cert','key'].includes(tipo)) return res.status(400).json({ message: 'tipo debe ser cert o key' });
    if (!req.file) return res.status(400).json({ message: 'Archivo requerido' });
    const pem = req.file.buffer.toString('utf8').trim();
    if (tipo === 'cert' && !pem.includes('CERTIFICATE')) return res.status(400).json({ message: 'El archivo no parece un certificado PEM válido' });
    if (tipo === 'key'  && !pem.includes('PRIVATE KEY'))  return res.status(400).json({ message: 'El archivo no parece una clave privada PEM válida' });

    const db = await getPool();
    const col = tipo === 'cert' ? 'cert_pem' : 'key_pem';
    let certVence = null;
    if (tipo === 'cert') {
      try {
        const { execSync } = require('child_process');
        const tmpFile = path.join(__dirname, 'certs', `tmp_${Date.now()}.crt`);
        fs.writeFileSync(tmpFile, pem);
        const out = execSync(`openssl x509 -noout -enddate -in "${tmpFile}"`, { encoding:'utf8', timeout:5000 }).trim();
        fs.unlinkSync(tmpFile);
        const dateStr = out.replace('notAfter=','');
        if (dateStr) certVence = new Date(dateStr).toISOString().split('T')[0];
      } catch {}
    }
    const sets = certVence ? `${col}=?, cert_vence=?` : `${col}=?`;
    const vals = certVence ? [pem, certVence, req.params.id] : [pem, req.params.id];
    await db.query(`UPDATE afip_contribuyentes SET ${sets} WHERE id=?`, vals);

    const { invalidateAfipInstance } = require('./afip-service');
    const [[c]] = await db.query('SELECT cuit FROM afip_contribuyentes WHERE id=?', [req.params.id]);
    if (c) invalidateAfipInstance(c.cuit);
    res.json({ ok: true, cert_vence: certVence });
  } catch(err) { res.status(500).json({ message: err.message }); }
});

// Padrón A5: consulta de contribuyente
app.get('/api/afip/contribuyente/:cuit', requireAuth, async (req, res) => {
  try {
    const { loadContrib, consultarContribuyente } = require('./afip-service');
    const db = await getPool();
    const contribId = req.query.contribuyente_id;
    let contrib;
    if (contribId) {
      contrib = await loadContrib(db, contribId);
    } else {
      const [[first]] = await db.query(
        `SELECT * FROM afip_contribuyentes WHERE activo=1 AND cert_pem IS NOT NULL AND key_pem IS NOT NULL LIMIT 1`);
      if (!first) return res.status(503).json({ message: 'No hay contribuyentes AFIP configurados con certificado' });
      contrib = first;
    }
    const cuit = req.params.cuit.replace(/[-\s]/g, '');
    if (!/^\d{11}$/.test(cuit)) return res.status(400).json({ message: 'CUIT/CUIL inválido' });
    const data = await consultarContribuyente(contrib, cuit);
    if (!data) return res.status(404).json({ message: 'Contribuyente no encontrado en AFIP' });
    res.json(data);
  } catch(err) { console.error('[AFIP Padrón]', err.message); res.status(500).json({ message: err.message }); }
});

// ── ARCA: sync por contribuyente ──────────────────────────────────────────────
async function _syncComprobantes(contrib, direccion, fechaDesde, fechaHasta) {
  const db = await getPool();
  const toDate = s => String(s||'').replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3').slice(0,10) || null;
  let nuevos = 0;

  const parseFecha = s => { if (!s) return null; const [d,m,y] = (s||'').split('/'); return y ? `${y}-${m}-${d}` : null; };
  const parseImporte = s => parseFloat(String(s||'0').replace(/\./g,'').replace(',','.').replace(/[^\d.-]/g,'')) || 0;
  const clave = process.env[`AFIP_CLAVE_${contrib.cuit}`];

  if (direccion === 'emitido') {
    if (!clave) {
      console.warn(`[ARCA sync] ${contrib.cuit} emitido: sin clave fiscal en .env (AFIP_CLAVE_${contrib.cuit}), saltando`);
    } else {
      const { scrapearComprobantesEmitidos } = require('./scraper');
      const lista = await scrapearComprobantesEmitidos(contrib.cuit, clave, fechaDesde, fechaHasta,
        msg => console.log(`[ARCA sync] ${contrib.cuit} emitido: ${msg}`));
      for (const item of lista) {
        if (!item.tipo || !item.pto_venta) continue;
        const tipoCod  = parseInt((item.tipo||'').split('-')[0].trim()) || 0;
        const descTipo = (item.tipo||'').split('-').slice(1).join('-').trim() || `Tipo ${tipoCod}`;
        const importe  = parseImporte(item.importe);
        await db.query(`
          INSERT INTO afip_comprobantes
            (direccion,codigo_tipo,desc_tipo,pto_venta,nro_comprobante,fecha_cbte,
             cuit_emisor,cuit_receptor,importe_total,raw_json)
          VALUES (?,?,?,?,?,?,?,?,?,?)
          ON DUPLICATE KEY UPDATE
            importe_total=VALUES(importe_total),raw_json=VALUES(raw_json),synced_at=CURRENT_TIMESTAMP
        `, ['emitido', tipoCod, descTipo, item.pto_venta, item.nro_comprobante,
            parseFecha(item.fecha), contrib.cuit, item.denominacion_receptor||null,
            importe, JSON.stringify(item)]);
        nuevos++;
      }
    }
  } else {
    const clave = process.env[`AFIP_CLAVE_${contrib.cuit}`];
    if (!clave) {
      console.warn(`[ARCA sync] ${contrib.cuit} recibido: sin clave fiscal en .env (AFIP_CLAVE_${contrib.cuit}), saltando`);
    } else {
      const { scrapearComprobantesRecibidos } = require('./scraper');
      const lista = await scrapearComprobantesRecibidos(contrib.cuit, clave, fechaDesde, fechaHasta,
        msg => console.log(`[ARCA sync] ${contrib.cuit} recibido: ${msg}`));
      for (const item of lista) {
        if (!item.tipo || !item.numero) continue;
        const [pvStr, nroStr] = (item.numero||'').split('-');
        const pv  = parseInt((pvStr||'').replace(/\D/g,''))  || 0;
        const nro = parseInt((nroStr||'').replace(/\D/g,'')) || 0;
        const tipoCod = parseInt((item.tipo||'').split('-')[0].trim()) || 0;
        const descTipo = (item.tipo||'').split('-').slice(1).join('-').trim() || `Tipo ${tipoCod}`;
        const emisor  = String(item.cuit_emisor||'').replace(/[-\s]/g,'') || '0';
        const importe = parseImporte(item.importe);
        await db.query(`
          INSERT INTO afip_comprobantes
            (direccion,codigo_tipo,desc_tipo,pto_venta,nro_comprobante,fecha_cbte,
             cuit_emisor,cuit_receptor,importe_total,raw_json)
          VALUES (?,?,?,?,?,?,?,?,?,?)
          ON DUPLICATE KEY UPDATE
            importe_total=VALUES(importe_total),raw_json=VALUES(raw_json),synced_at=CURRENT_TIMESTAMP
        `, ['recibido', tipoCod, descTipo, pv, nro,
            parseFecha(item.fecha), emisor, contrib.cuit, importe, JSON.stringify(item)]);
        nuevos++;
      }
    }
  }

  await db.query(`INSERT INTO afip_sync_log (direccion,fecha_desde,fecha_hasta,total_nuevos) VALUES (?,?,?,?)`,
    [direccion, fechaDesde, fechaHasta, nuevos]);
  return nuevos;
}

app.post('/api/arca/test-scraper', requireAuth, async (req, res) => {
  try {
    const { cuit, desde, hasta, direccion = 'emitido' } = req.body;
    const clave = process.env[`AFIP_CLAVE_${cuit}`];
    if (!clave) return res.status(400).json({ message: `Sin clave en .env para AFIP_CLAVE_${cuit}` });
    const { scrapearComprobantesRecibidos, scrapearComprobantesEmitidos } = require('./scraper');
    const fechaDesde = desde || new Date(Date.now() - 30*864e5).toISOString().split('T')[0];
    const fechaHasta = hasta || new Date().toISOString().split('T')[0];
    const fn = direccion === 'recibido' ? scrapearComprobantesRecibidos : scrapearComprobantesEmitidos;
    const lista = await fn(cuit, clave, fechaDesde, fechaHasta,
      msg => console.log(`[test-scraper] ${msg}`));
    res.json({ ok: true, direccion, total: lista.length, lista });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/arca/sync', requireAuth, async (req, res) => {
  try {
    const { contribuyente_id, direccion = 'ambos', desde, hasta } = req.body;
    const db = await getPool();
    const { loadContrib } = require('./afip-service');
    let contribs = [];
    if (contribuyente_id) {
      contribs = [await loadContrib(db, contribuyente_id)];
    } else {
      const [all] = await db.query(
        `SELECT * FROM afip_contribuyentes WHERE activo=1 AND cert_pem IS NOT NULL AND key_pem IS NOT NULL`);
      contribs = all;
    }
    if (!contribs.length) return res.status(503).json({ message: 'No hay contribuyentes AFIP configurados con certificado' });

    let fechaDesde = desde;
    if (!fechaDesde) {
      const [[last]] = await db.query(`SELECT MAX(fecha_hasta) AS last FROM afip_sync_log WHERE error IS NULL`);
      if (last?.last) { const d = new Date(last.last); d.setDate(d.getDate()+1); fechaDesde = d.toISOString().split('T')[0]; }
      else { const d = new Date(); d.setDate(d.getDate()-30); fechaDesde = d.toISOString().split('T')[0]; }
    }
    const fechaHasta = hasta || new Date().toISOString().split('T')[0];
    const dirs = direccion === 'ambos' ? ['emitido','recibido'] : [direccion];
    let total = 0;
    for (const c of contribs)
      for (const d of dirs) {
        try { total += await _syncComprobantes(c, d, fechaDesde, fechaHasta); }
        catch(e) {
          if (e.message.includes('WSCDC') || e.message.includes('Invalid WSDL')) {
            // WSCDC no disponible — skip silencioso
          } else {
            console.warn(`[ARCA sync] ${c.cuit} ${d}: ${e.message}`);
          }
        }
      }
    res.json({ ok: true, nuevos: total, desde: fechaDesde, hasta: fechaHasta });
  } catch(err) { console.error('[ARCA sync]', err.message); res.status(500).json({ message: err.message }); }
});

app.get('/api/arca/comprobantes', requireAuth, async (req, res) => {
  try {
    const db = await getPool();
    const { direccion = 'emitido', desde, hasta, tipo, cuit_emisor } = req.query;
    const conds = ['direccion=?']; const vals = [direccion];
    if (desde)       { conds.push('fecha_cbte>=?');  vals.push(desde); }
    if (hasta)       { conds.push('fecha_cbte<=?');  vals.push(hasta); }
    if (tipo)        { conds.push('codigo_tipo=?');  vals.push(parseInt(tipo)); }
    if (cuit_emisor) { conds.push('cuit_emisor=?');  vals.push(cuit_emisor); }
    const [rows] = await db.query(
      `SELECT id,direccion,codigo_tipo,desc_tipo,pto_venta,nro_comprobante,fecha_cbte,
              fecha_vto_pago,cuit_emisor,cuit_receptor,razon_social,
              importe_total,importe_iva,cae,cae_vto,estado,pdf_url
       FROM afip_comprobantes WHERE ${conds.join(' AND ')}
       ORDER BY fecha_cbte DESC, nro_comprobante DESC LIMIT 500`, vals);
    res.json(rows);
  } catch(err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/arca/sync-info', requireAuth, async (req, res) => {
  try {
    const db = await getPool();
    const [[row]] = await db.query(`SELECT MAX(synced_at) AS last_sync, MAX(fecha_hasta) AS last_fecha FROM afip_sync_log WHERE error IS NULL`);
    res.json(row);
  } catch(err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/arca/comprobantes/:id/pdf', requireAuth, memUpload.single('pdf'), async (req, res) => {
  try {
    if (!req.file || req.file.mimetype !== 'application/pdf') return res.status(400).json({ message: 'Se requiere un PDF' });
    const db = await getPool();
    const [[row]] = await db.query('SELECT id FROM afip_comprobantes WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ message: 'Comprobante no encontrado' });
    const dir = path.join(__dirname, 'public', 'uploads', 'facturas');
    fs.mkdirSync(dir, { recursive: true });
    const fname = `arca_${req.params.id}_${Date.now()}.pdf`;
    fs.writeFileSync(path.join(dir, fname), req.file.buffer);
    await db.query('UPDATE afip_comprobantes SET pdf_url=? WHERE id=?', [`/uploads/facturas/${fname}`, req.params.id]);
    res.json({ ok: true, pdf_url: `/uploads/facturas/${fname}` });
  } catch(err) { res.status(500).json({ message: err.message }); }
});

// ── Facturar una cobranza directo via AFIP (multi-contribuyente) ──────────────
app.post('/api/pagos/:id/facturar-afip', requireAuth, async (req, res) => {
  const pagoId = parseInt(req.params.id);
  try {
    const db = await getPool();
    const [[pago]] = await db.query('SELECT * FROM pagos WHERE id=?', [pagoId]);
    if (!pago) return res.status(404).json({ message: 'Cobranza no encontrada' });
    if (pago.factura_url) return res.status(409).json({ message: 'Esta cobranza ya tiene factura emitida' });

    const { loadContrib, emitirFactura } = require('./afip-service');

    // Resolver contribuyente: cuenta → propietario (persona) → afip_contribuyentes por CUIL/CUIT
    let contribuyente_id = req.body?.contribuyente_id;
    if (!contribuyente_id && pago.cuenta_id) {
      const [[autoContrib]] = await db.query(`
        SELECT ac.id
        FROM cuentas c
        JOIN personas pe ON pe.id = c.persona_id
        JOIN afip_contribuyentes ac
          ON REPLACE(REPLACE(ac.cuit, '-', ''), ' ', '') = REPLACE(REPLACE(pe.cuil, '-', ''), ' ', '')
        WHERE c.id = ? AND ac.activo = 1 AND ac.cert_pem IS NOT NULL AND ac.key_pem IS NOT NULL
        LIMIT 1
      `, [pago.cuenta_id]);
      if (autoContrib) contribuyente_id = autoContrib.id;
    }
    if (!contribuyente_id) return res.status(400).json({ message: 'No se encontró contribuyente AFIP para la cuenta. Seleccionalo manualmente.' });
    const contrib = await loadContrib(db, contribuyente_id);

    const monto        = parseFloat(pago.monto_total || pago.monto || 0);
    const ref          = pago.nro_transaccion || pago.codigo_identificacion || `Cob.${pagoId}`;
    const conceptoBase = contrib.concepto_base || 'Alquiler vehículo';
    const result       = await emitirFactura(contrib, { monto, concepto: `${conceptoBase} (Op. ${ref})`, ref });

    const nroFmt = `${String(result.punto_venta).padStart(5,'0')}-${String(result.nro_comprobante).padStart(8,'0')}`;
    await db.query(
      `UPDATE pagos SET factura_ref='afip', factura_cae=?, factura_cae_vto=?,
        factura_tipo='Factura B', factura_numero=?, factura_fecha=CURDATE() WHERE id=?`,
      [result.cae, result.cae_vto, nroFmt, pagoId]);

    await registrarAuditoria(req, 'pagos', 'afip-facturar', pagoId,
      `Factura B emitida — CUIT ${result.cuit_emisor} (${result.nombre_emisor}) · CAE ${result.cae} · ${nroFmt}`);

    res.json({ ok: true, cae: result.cae, cae_vto: result.cae_vto, nro: result.nro_comprobante, emisor: result.nombre_emisor });
  } catch(err) { console.error('[AFIP facturar]', err.message); res.status(500).json({ message: err.message }); }
});

// ── Facturar una cobranza via Facturitas bot ─────────────────────────────────
app.post('/api/pagos/:id/facturar', requireAuth, async (req, res) => {
  const pagoId = parseInt(req.params.id);
  if (!botReadyStatus) return res.status(503).json({ message: 'WhatsApp no conectado' });
  try {
    const db = await getPool();
    const [[pago]] = await db.query('SELECT * FROM pagos WHERE id=?', [pagoId]);
    if (!pago) return res.status(404).json({ message: 'Cobranza no encontrada' });
    if (pago.factura_url || pago.factura_ref === 'pending') return res.status(409).json({ message: 'Esta cobranza ya fue enviada a facturar' });

    const client  = waSessions.get('default').client;
    const chatId  = await _resolveWaChatId(client, FACTURITAS_NUMBER);
    const monto   = Math.round(parseFloat(pago.monto));

    // Marcar en DB como pendiente de factura (persiste aunque se reinicie el server)
    await db.query("UPDATE pagos SET factura_ref='pending' WHERE id=?", [pagoId]);
    _pendingFactura = { pagoId, ts: Date.now() };

    // Auto-cancelar si Facturitas no envía el PDF en 10 minutos
    setTimeout(async () => {
      try {
        const [[row]] = await db.query("SELECT factura_ref FROM pagos WHERE id=?", [pagoId]);
        if (row?.factura_ref === 'pending') {
          await db.query("UPDATE pagos SET factura_ref=NULL WHERE id=?", [pagoId]);
          if (_pendingFactura?.pagoId === pagoId) _pendingFactura = null;
          console.warn(`[FACTURITAS] Timeout 10min — factura_ref reseteada para pago #${pagoId}`);
        }
      } catch(_) {}
    }, 10 * 60 * 1000);

    // Esperar respuesta del bot Facturitas (timeout fallback)
    // Usa la misma normalización del handler principal para soportar @lid, @c.us y @s.whatsapp.net
    const _waitFacturitas = (ms = 12000) => new Promise(resolve => {
      const handler = msg => {
        const bare = msg.from.replace(/[@:].*/,'').replace(/[^\d]/g,'');
        if (_isFacturitas(bare)) { client.off('message', handler); client.off('message_create', handler); clearTimeout(t); resolve(msg); }
      };
      const t = setTimeout(() => { client.off('message', handler); client.off('message_create', handler); resolve(null); }, ms);
      client.on('message', handler);
      client.on('message_create', handler);
    });

    // Flujo: Crear Factura Rápida → esperar → Alquiler → esperar → monto → esperar → Confirmar
    await client.sendMessage(chatId, 'Crear Factura Rápida');
    await _waitFacturitas();                          // espera "Ingrese el producto..."
    const nroRef = pago.nro_transaccion || pago.codigo_identificacion || null;
    const svcName = nroRef ? `Alquiler (Op. ${nroRef})` : `Alquiler (Cob. ${pagoId})`;
    await client.sendMessage(chatId, svcName);
    await _waitFacturitas();                          // espera "Ingrese el precio..."
    await client.sendMessage(chatId, String(monto));
    await _waitFacturitas();                          // espera confirmación
    await client.sendMessage(chatId, 'Confirmar');

    res.json({ ok: true, message: 'Factura solicitada. El PDF se vinculará automáticamente cuando llegue.' });
  } catch (err) {
    _pendingFactura = null;
    // Frame detached = WhatsApp Web recargó su página durante la operación
    if (err.message?.includes('detached Frame') || err.message?.includes('Execution context was destroyed')) {
      botReadyStatus = false;
      // Resetear el pending en DB para que se pueda reintentar
      try { const db2 = await getPool(); await db2.query("UPDATE pagos SET factura_ref=NULL WHERE id=? AND factura_ref='pending'", [pagoId]); } catch(_) {}
      return res.status(503).json({ message: 'WhatsApp Web se desconectó durante el envío. Reconectá el bot en Credenciales y volvé a intentar.' });
    }
    res.status(500).json({ message: err.message });
  }
});

// Buscar último PDF de Facturitas en historial WA y vincularlo al pago
app.post('/api/pagos/:id/factura-buscar-wa', requireAuth, async (req, res) => {
  const pagoId = parseInt(req.params.id);
  console.log(`[FACTURITAS] buscar-wa solicitado para pago #${pagoId} — botReady=${botReadyStatus}`);
  try {
    if (!botReadyStatus) return res.status(503).json({ message: 'WhatsApp no conectado' });
    // Usar el último PDF recibido por el bot (fetchMessages falla con cuentas business en wwebjs)
    // Recuperar desde memoria; si no está (ej: reinicio), leer del disco
    if (!_lastPdfFacturitas) {
      try {
        const _lpPath = path.join(__dirname, 'public', 'uploads', 'facturas', '_last_facturitas.pdf');
        if (fs.existsSync(_lpPath)) {
          const buf = fs.readFileSync(_lpPath);
          const stat = fs.statSync(_lpPath);
          _lastPdfFacturitas = { data: buf.toString('base64'), mimetype: 'application/pdf', ts: stat.mtimeMs };
          console.log(`[FACTURITAS] buscar-wa: _lastPdfFacturitas recuperado desde disco`);
        }
      } catch(_lpErr) { console.warn('[FACTURITAS] No se pudo leer last PDF de disco:', _lpErr.message); }
    }
    if (!_lastPdfFacturitas) return res.status(404).json({ message: 'No hay PDF reciente de Facturitas en memoria. Esperá que llegue el PDF y volvé a intentar.' });
    const agoMin = Math.round((Date.now() - _lastPdfFacturitas.ts) / 60000);
    console.log(`[FACTURITAS] buscar-wa usando _lastPdfFacturitas (hace ${agoMin} min)`);
    const media = { data: _lastPdfFacturitas.data, mimetype: _lastPdfFacturitas.mimetype };

    const db  = await getPool();
    const buf = Buffer.from(media.data, 'base64');
    const dir = path.join(__dirname, 'public', 'uploads', 'facturas');
    fs.mkdirSync(dir, { recursive: true });
    const fname       = `factura_${pagoId}_${Date.now()}.pdf`;
    fs.writeFileSync(path.join(dir, fname), buf);
    const factura_url = `/uploads/facturas/${fname}`;
    await db.query("UPDATE pagos SET factura_url=?, factura_ref=NULL WHERE id=?", [factura_url, pagoId]);
    if (_pendingFactura?.pagoId === pagoId) _pendingFactura = null;
    console.log(`[FACTURITAS] PDF recuperado de historial WA → pago #${pagoId}`);
    res.json({ ok: true, factura_url });
  } catch(err) {
    console.error('[FACTURITAS] buscar-wa error:', err.message, err.stack?.split('\n')[1] || '');
    res.status(500).json({ message: err.message || String(err) });
  }
});

// Cancelar estado "pending" de factura (Facturitas no respondió)
app.delete('/api/pagos/:id/factura-pending', requireAuth, async (req, res) => {
  try {
    const db = await getPool();
    await db.query("UPDATE pagos SET factura_ref=NULL WHERE id=? AND factura_ref='pending'", [req.params.id]);
    if (_pendingFactura?.pagoId === parseInt(req.params.id)) _pendingFactura = null;
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ message: err.message }); }
});

// Subir factura PDF manualmente a un cobro (usa memoryStorage para evitar problemas con req.params en diskStorage)
app.post('/api/pagos/:id/factura-manual', memUpload.single('pdf'), async (req, res) => {
  try {
    if (!req.file || req.file.mimetype !== 'application/pdf')
      return res.status(400).json({ message: 'Se requiere un PDF' });
    const pagoId = parseInt(req.params.id);
    const db = await getPool();
    const [[pago]] = await db.query('SELECT id FROM pagos WHERE id=?', [pagoId]);
    if (!pago) return res.status(404).json({ message: 'Cobranza no encontrada' });
    const dir = path.join(__dirname, 'public', 'uploads', 'facturas');
    fs.mkdirSync(dir, { recursive: true });
    const fname = `factura_${pagoId}_${Date.now()}.pdf`;
    fs.writeFileSync(path.join(dir, fname), req.file.buffer);
    const factura_url = `/uploads/facturas/${fname}`;
    await db.query("UPDATE pagos SET factura_url=?, factura_ref=NULL WHERE id=?", [factura_url, pagoId]);
    res.json({ ok: true, factura_url });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/pagos/:id', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM pagos WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'No encontrado' });
    const p = rows[0];
    await db.query('DELETE FROM pagos WHERE id = ?', [req.params.id]);
    await registrarAuditoria(req, 'pagos', 'eliminar', req.params.id, `Cobro eliminado: chofer_id=${p.chofer_id}, monto=${p.monto}, fecha=${p.fecha}`);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/usuarios/:id/permisos', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT pantalla, puede_eliminar FROM permisos_pantallas WHERE usuario_id = ? AND permitido = 1', [req.params.id]);
    res.json({ pantallas: rows.map(r => r.pantalla), puede_eliminar: rows.some(r => r.puede_eliminar === 1) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Auditoría ────────────────────────────────────────────────────────────────
app.post('/api/auditoria/accion', async (req, res) => {
  const { modulo, accion, entidad_id, descripcion } = req.body;
  await registrarAuditoria(req, modulo || 'visor', accion || 'accion', entidad_id || null, descripcion || null);
  res.json({ ok: true });
});

app.get('/api/auditoria', async (req, res) => {
  try {
    const db = await getPool();
    const { modulo, accion, usuario_id, desde, hasta, limit: lim = 200 } = req.query;
    const where = []; const vals = [];
    if (modulo)     { where.push('modulo=?');      vals.push(modulo); }
    if (accion)     { where.push('accion=?');       vals.push(accion); }
    if (usuario_id) { where.push('usuario_id=?');   vals.push(usuario_id); }
    if (desde)      { where.push('fecha>=?');        vals.push(desde); }
    if (hasta)      { where.push('fecha<=?');        vals.push(hasta + ' 23:59:59'); }
    const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [rows] = await db.query(`SELECT * FROM auditoria ${cond} ORDER BY fecha DESC LIMIT ?`, [...vals, parseInt(lim)]);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── CREDENCIALES IA ──────────────────────────────────────────────────────────
app.get('/api/ia/credenciales', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT id,nombre,proveedor,modelo,activa,precio_input,precio_output,notas,created_at,updated_at, LEFT(api_key,8) AS api_key_preview FROM credenciales_ia ORDER BY activa DESC, id ASC');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/ia/credenciales', async (req, res) => {
  try {
    const db = await getPool();
    const { nombre, proveedor='anthropic', api_key, modelo='claude-sonnet-4-6', activa=0, precio_input=3, precio_output=15, notas='' } = req.body;
    if (!nombre || !api_key) return res.status(400).json({ message: 'Nombre y API Key son obligatorios' });
    if (activa) await db.query('UPDATE credenciales_ia SET activa=0');
    const [r] = await db.query('INSERT INTO credenciales_ia (nombre,proveedor,api_key,modelo,activa,precio_input,precio_output,notas) VALUES (?,?,?,?,?,?,?,?)',
      [nombre, proveedor, api_key, modelo, activa?1:0, precio_input, precio_output, notas]);
    _invalidateIACredCache();
    res.status(201).json({ id: r.insertId });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put('/api/ia/credenciales/:id', async (req, res) => {
  try {
    const db = await getPool();
    const { nombre, proveedor, api_key, modelo, activa, precio_input, precio_output, notas } = req.body;
    if (activa) await db.query('UPDATE credenciales_ia SET activa=0');
    const sets = []; const vals = [];
    if (nombre       !== undefined) { sets.push('nombre=?');        vals.push(nombre); }
    if (proveedor    !== undefined) { sets.push('proveedor=?');     vals.push(proveedor); }
    if (api_key      !== undefined && api_key !== '') { sets.push('api_key=?'); vals.push(api_key); }
    if (modelo       !== undefined) { sets.push('modelo=?');        vals.push(modelo); }
    if (activa       !== undefined) { sets.push('activa=?');        vals.push(activa?1:0); }
    if (precio_input !== undefined) { sets.push('precio_input=?');  vals.push(precio_input); }
    if (precio_output!== undefined) { sets.push('precio_output=?'); vals.push(precio_output); }
    if (notas        !== undefined) { sets.push('notas=?');         vals.push(notas); }
    if (!sets.length) return res.status(400).json({ message: 'Nada que actualizar' });
    vals.push(req.params.id);
    await db.query(`UPDATE credenciales_ia SET ${sets.join(',')} WHERE id=?`, vals);
    _invalidateIACredCache();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/ia/credenciales/:id', async (req, res) => {
  try {
    const db = await getPool();
    await db.query('DELETE FROM credenciales_ia WHERE id=?', [req.params.id]);
    _invalidateIACredCache();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── LOG DE USO IA ─────────────────────────────────────────────────────────────
app.get('/api/ia/log', async (req, res) => {
  try {
    const db = await getPool();
    const { desde, hasta, tarea, limit: lim = 200 } = req.query;
    const where = []; const vals = [];
    if (desde) { where.push('l.fecha>=?'); vals.push(desde); }
    if (hasta) { where.push('l.fecha<=?'); vals.push(hasta + ' 23:59:59'); }
    if (tarea) { where.push('l.tarea LIKE ?'); vals.push('%' + tarea + '%'); }
    const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [rows] = await db.query(
      `SELECT l.*, c.nombre AS credencial_nombre FROM ia_log l LEFT JOIN credenciales_ia c ON c.id=l.credencial_id ${cond} ORDER BY l.fecha DESC LIMIT ?`,
      [...vals, parseInt(lim)]
    );
    const [[totals]] = await db.query('SELECT COUNT(*) AS total, SUM(input_tokens) AS total_input, SUM(output_tokens) AS total_output, SUM(costo_usd) AS total_costo FROM ia_log l ' + cond, vals);
    res.json({ rows, totals });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// NUEVOS ENDPOINTS — Módulos IA, R2, Contactos, Alertas, Documentos Choferes
// ============================================================

const { uploadFile } = require('./r2');
const { extractCedulaData, extractGncData, extractSeguroData } = require('./ai');
let pdfParse;
try { pdfParse = require('pdf-parse'); } catch (e) { pdfParse = null; }

// ── Configuración / Credenciales (superadmin) ────────────────────────────────

// Carga credenciales de DB en process.env (llamar al arrancar)
async function loadConfigFromDB() {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT clave, valor FROM configuracion WHERE valor IS NOT NULL AND valor != ""');
    for (const { clave, valor } of rows) {
      if (!process.env[clave]) process.env[clave] = valor; // .env tiene prioridad
    }
    // Si la DB tiene API key, actualizar el cliente Anthropic
    if (rows.find(r => r.clave === 'ANTHROPIC_API_KEY' && r.valor)) {
      try { require('@anthropic-ai/sdk'); } catch (_) {}
    }
  } catch (e) { console.warn('[Config] No se pudo cargar config de DB:', e.message); }
}

app.get('/api/config/credenciales', async (req, res) => {
  if (!req.session?.usuario || req.session.usuario.rol !== 'superadmin')
    return res.status(403).json({ message: 'Solo superadmin' });
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT clave, valor, descripcion FROM configuracion ORDER BY clave ASC');
    // Claves que siempre deben aparecer aunque no estén en DB
    const ALWAYS_SHOW = ['ANTHROPIC_API_KEY','R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET_NAME','R2_PUBLIC_URL','SHEETJS_LICENSE_KEY'];
    const existing = new Set(rows.map(r => r.clave));
    for (const clave of ALWAYS_SHOW) {
      if (!existing.has(clave)) rows.push({ clave, valor: null, descripcion: null });
    }
    rows.sort((a, b) => a.clave.localeCompare(b.clave));
    const result = rows.map(r => ({
      clave: r.clave,
      descripcion: r.descripcion,
      tieneValor: !!(r.valor),
      preview: r.valor ? '••••' + r.valor.slice(-4) : ''
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put('/api/config/credenciales', async (req, res) => {
  if (!req.session?.usuario || req.session.usuario.rol !== 'superadmin')
    return res.status(403).json({ message: 'Solo superadmin' });
  const { credenciales } = req.body; // [{ clave, valor }]
  if (!Array.isArray(credenciales)) return res.status(400).json({ message: 'Formato inválido' });
  try {
    const db = await getPool();
    for (const { clave, valor } of credenciales) {
      if (!clave) continue;
      if (valor === null || valor === undefined || valor === '') {
        // Limpiar sin borrar la fila (mantener descripción)
        await db.query('UPDATE configuracion SET valor = NULL WHERE clave = ?', [clave]);
        delete process.env[clave];
      } else {
        await db.query(
          'INSERT INTO configuracion (clave, valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)',
          [clave, valor.trim()]
        );
        process.env[clave] = valor.trim(); // aplicar en runtime
      }
    }
    res.json({ message: 'Credenciales guardadas' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// -- Estado de disponibilidad de IA
app.get('/api/ai/status', async (req, res) => {
  try {
    const db = await getPool();
    const [[row]] = await db.query('SELECT id FROM credenciales_ia WHERE activa=1 LIMIT 1');
    res.json({ available: !!row || !!process.env.ANTHROPIC_API_KEY });
  } catch (_) {
    res.json({ available: !!process.env.ANTHROPIC_API_KEY });
  }
});

// -- Bloquear todos los endpoints de IA si no hay API key configurada
app.use('/api/ai', (req, res, next) => {
  if (req.path === '/status' || req.method === 'GET') return next();
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ message: 'Se debe configurar las credenciales de IA en el servidor.' });
  }
  next();
});

// -- Aseguradoras: crear nueva
app.post('/api/aseguradoras', async (req, res) => {
  const { nombre, cuit, web, domicilio, entre_calles, codigo_postal, telefono, email, notas } = req.body;
  if (!nombre) return res.status(400).json({ message: 'Nombre es requerido' });
  try {
    const db = await getPool();
    const [existing] = await db.query('SELECT id FROM aseguradoras WHERE LOWER(nombre)=LOWER(?)', [nombre]);
    if (existing.length) return res.json({ id: existing[0].id, nombre });
    const { lat, lng } = req.body;
    const [result] = await db.query(
      `INSERT INTO aseguradoras (nombre,cuit,web,domicilio,entre_calles,codigo_postal,lat,lng,telefono,email,notas) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [nombre, cuit||null, web||null, domicilio||null, entre_calles||null, codigo_postal||null, lat||null, lng||null, telefono||null, email||null, notas||null]
    );
    await registrarAuditoria(req, 'aseguradoras', 'crear', result.insertId, `Nueva aseguradora: ${nombre}`);
    res.status(201).json({ id: result.insertId, nombre });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// -- AI: extraer datos de cédula
app.post('/api/ai/extract-cedula', memUpload.fields([{ name: 'frente', maxCount: 1 }, { name: 'dorso', maxCount: 1 }]), async (req, res) => {
  try {
    const frente = req.files?.frente?.[0];
    const dorso = req.files?.dorso?.[0];
    if (!frente) return res.status(400).json({ message: 'Se requiere imagen frente de cédula' });
    const data = await extractCedulaData(frente.buffer, frente.mimetype, dorso?.buffer || null, dorso?.mimetype || null);
    res.json(data);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// -- AI: extraer datos de oblea GNC
// -- AI: OCR genérico de imagen (texto libre)
app.post('/api/ai/ocr-text', memUpload.single('img'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Se requiere imagen' });
    const { extractTextFromImage } = require('./ai');
    const isPdf = req.file.mimetype === 'application/pdf' || req.file.originalname?.toLowerCase().endsWith('.pdf');
    if (isPdf) {
      // Enviar PDF directo como documento — Claude lo lee visualmente
      const text = await extractTextFromImage(req.file.buffer, 'application/pdf');
      res.json({ text });
    } else {
      const text = await extractTextFromImage(req.file.buffer, req.file.mimetype);
      res.json({ text });
    }
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/ai/extract-gnc', memUpload.single('oblea'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Se requiere imagen de oblea' });
    const data = await extractGncData(req.file.buffer, req.file.mimetype);
    res.json(data);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// -- AI: extraer datos de póliza de seguro (imagen o PDF)
app.post('/api/ai/extract-seguro', memUpload.single('poliza'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Se requiere archivo de póliza' });
    let data;
    if (req.file.mimetype === 'application/pdf') {
      if (!pdfParse) return res.status(500).json({ message: 'pdf-parse no disponible' });
      const parsed = await pdfParse(req.file.buffer);
      data = await extractSeguroData(parsed.text, false, null);
    } else {
      data = await extractSeguroData(req.file.buffer.toString('base64'), true, req.file.mimetype);
    }
    res.json(data);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// AI extracción de VTV
app.post('/api/ai/extract-vtv', memUpload.single('vtv'), async (req, res) => {
  try {
    const { extractVtvData } = require('./ai');
    const pdfParse = require('pdf-parse');
    let data;
    if (req.file.mimetype === 'application/pdf') {
      const pdfData = await pdfParse(req.file.buffer);
      data = await extractVtvData(pdfData.text, false, null);
    } else {
      data = await extractVtvData(req.file.buffer.toString('base64'), true, req.file.mimetype);
    }
    console.log('[VTV-AI] extraído:', JSON.stringify(data));
    res.json(data);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Upload VTV con archivo (guarda local, R2 si disponible)
app.post('/api/vehiculos/:id/vtv-upload', memUpload.single('vtv'), async (req, res) => {
  try {
    const { uploadFile } = require('./r2');
    const fs = require('fs');
    const pathM = require('path');
    let fileUrl = null;
    if (req.file) {
      try {
        // Intentar R2
        fileUrl = await uploadFile(req.file.buffer, req.file.originalname, `vtv/${req.params.id}`);
      } catch(r2err) {
        // Fallback local
        const dir = pathM.join(__dirname, 'public', 'uploads', 'vtv', req.params.id);
        fs.mkdirSync(dir, { recursive: true });
        const fname = `vtv_${Date.now()}${pathM.extname(req.file.originalname)}`;
        fs.writeFileSync(pathM.join(dir, fname), req.file.buffer);
        fileUrl = `/uploads/vtv/${req.params.id}/${fname}`;
      }
    }
    const { vigencia_desde, vigencia_hasta, resultado, patente_vtv, fecha_inspeccion, notas, nro_inspeccion, nro_oblea } = req.body;
    const db = await getPool();
    const [r] = await db.query(
      `INSERT INTO vehiculo_vtv (vehiculo_id, vigencia_desde, vigencia_hasta, archivo_adjunto, resultado, patente_vtv, fecha_inspeccion, notas, nro_inspeccion, nro_oblea) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [req.params.id, vigencia_desde, vigencia_hasta, fileUrl, resultado||null, patente_vtv||null, fecha_inspeccion||null, notas||null, nro_inspeccion||null, nro_oblea||null]
    );
    const hasta = new Date(vigencia_hasta);
    const dias = Math.ceil((hasta - new Date()) / 86400000);
    if (dias <= 60) {
      const msg = dias < 0 ? `VTV VENCIDA hace ${Math.abs(dias)} días` : `VTV vence en ${dias} días (${vigencia_hasta})`;
      await db.query(`INSERT INTO alertas_vencimiento (vehiculo_id, tipo, referencia_id, mensaje, fecha_vencimiento) VALUES (?,?,?,?,?)`,
        [req.params.id, 'vtv', r.insertId, msg, vigencia_hasta]).catch(()=>{});
    }
    const [[vehVtvUp]] = await db.query('SELECT patente FROM vehiculos WHERE id=?', [req.params.id]);
    await registrarAuditoria(req, 'vehiculos', 'vtv_agregar', req.params.id, `VTV agregada para ${vehVtvUp?.patente||req.params.id} — vigencia hasta ${vigencia_hasta}`);
    res.status(201).json({ message: 'VTV guardada', id: r.insertId, archivo_url: fileUrl });
  } catch(err) { res.status(500).json({ message: err.message }); }
});

// AI extracción de multa/infracción
app.post('/api/ai/extract-multa', memUpload.single('multa'), async (req, res) => {
  try {
    const { extractMultaData } = require('./ai');
    let data;
    if (req.file.mimetype === 'application/pdf') {
      // Enviar PDF directo — Claude lo lee visualmente (funciona con PDFs escaneados sin texto)
      data = await extractMultaData(req.file.buffer.toString('base64'), false, 'application/pdf');
    } else {
      data = await extractMultaData(req.file.buffer.toString('base64'), true, req.file.mimetype);
    }
    res.json(data);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// AI extracción de factura
app.post('/api/ai/extract-factura', memUpload.single('factura'), async (req, res) => {
  try {
    const { extractFacturaData } = require('./ai');
    const pdfParse = require('pdf-parse');
    let data;
    if (req.file.mimetype === 'application/pdf') {
      const pdfData = await pdfParse(req.file.buffer);
      data = await extractFacturaData(pdfData.text, false, null);
    } else {
      data = await extractFacturaData(req.file.buffer.toString('base64'), true, req.file.mimetype);
    }
    res.json(data);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// AI extracción de km + combustible desde foto de tablero (también guarda la imagen)
app.post('/api/ai/extract-km', memUpload.single('imagen'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Sin imagen' });
    const { extractKmData } = require('./ai');
    const pathM = require('path'), fs = require('fs');
    // Guardar imagen
    const dir = pathM.join(__dirname, 'public', 'uploads', 'turnos');
    fs.mkdirSync(dir, { recursive: true });
    const ext   = req.file.originalname.split('.').pop() || 'jpg';
    const fname = `tablero_${Date.now()}.${ext}`;
    fs.writeFileSync(pathM.join(dir, fname), req.file.buffer);
    const foto_url = `/uploads/turnos/${fname}`;
    // Extraer datos con IA
    const turnoId = req.body?.turno_id || req.query?.turno_id || null;
    const data = await extractKmData(req.file.buffer, req.file.mimetype, { modulo: 'Turnos', entidad_id: turnoId ? parseInt(turnoId) : null });
    res.json({ ...data, foto_url });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// AI extracción de nivel de aceite desde foto de varilla
app.post('/api/ai/extract-aceite', memUpload.single('imagen'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Sin imagen' });
    const { extractAceiteData } = require('./ai');
    const pathM = require('path'), fs = require('fs');
    const dir = pathM.join(__dirname, 'public', 'uploads', 'turnos');
    fs.mkdirSync(dir, { recursive: true });
    const ext   = req.file.originalname.split('.').pop() || 'jpg';
    const fname = `aceite_${Date.now()}.${ext}`;
    fs.writeFileSync(pathM.join(dir, fname), req.file.buffer);
    const foto_url = `/uploads/turnos/${fname}`;
    const turnoId = req.body?.turno_id || req.query?.turno_id || null;
    const data = await extractAceiteData(req.file.buffer, req.file.mimetype, { modulo: 'Turnos', entidad_id: turnoId ? parseInt(turnoId) : null });
    res.json({ ...data, foto_url });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Upload simple de foto de turno sin procesamiento IA
app.post('/api/upload/turno-foto', memUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Sin archivo' });
    const pathM = require('path'), fs = require('fs');
    const dir = pathM.join(__dirname, 'public', 'uploads', 'turnos');
    fs.mkdirSync(dir, { recursive: true });
    const ext = req.file.originalname.split('.').pop() || 'jpg';
    const fname = `foto_${Date.now()}.${ext}`;
    fs.writeFileSync(pathM.join(dir, fname), req.file.buffer);
    res.json({ url: `/uploads/turnos/${fname}` });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Upload comprobante de pago de multa
app.post('/api/upload/multa-foto', memUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Sin archivo' });
    const pathM = require('path'), fs = require('fs');
    const dir = pathM.join(__dirname, 'public', 'uploads', 'multas');
    fs.mkdirSync(dir, { recursive: true });
    const ext = req.file.originalname.split('.').pop() || 'pdf';
    const fname = `pago_${Date.now()}.${ext}`;
    fs.writeFileSync(pathM.join(dir, fname), req.file.buffer);
    res.json({ url: `/uploads/multas/${fname}` });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Verificar pago en Mercado Pago por ID de operación
app.get('/api/mp/payment/:id', async (req, res) => {
  try {
    const token = process.env.MP_ACCESS_TOKEN;
    if (!token) return res.status(500).json({ message: 'MP_ACCESS_TOKEN no configurado' });
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${req.params.id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await mpRes.json();
    if (!mpRes.ok) return res.status(mpRes.status).json({ message: data.message || 'Error MP' });
    res.json({
      id:              data.id,
      status:          data.status,
      status_detail:   data.status_detail,
      monto:           data.transaction_amount,
      moneda:          data.currency_id,
      fecha:           data.date_approved || data.date_created,
      descripcion:     data.description,
      pagador_email:   data.payer?.email,
      pagador_nombre:  [data.payer?.first_name, data.payer?.last_name].filter(Boolean).join(' '),
      medio:           data.payment_method_id,
      tipo:            data.payment_type_id,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// OCR de tablero/odómetro — extrae km usando Tesseract en modo numérico
app.post('/api/ocr/tablero', memUpload.single('imagen'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Sin imagen' });
  const tmp = path.join(__dirname, 'public', 'uploads', `_tablero_${Date.now()}.jpg`);
  try {
    fs.writeFileSync(tmp, req.file.buffer);
    const { data: { text } } = await Tesseract.recognize(tmp, 'eng', {
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '6'  // uniform block of text
    });
    fs.unlink(tmp, () => {});
    const raw = text.replace(/\D/g, '');
    // Buscar secuencia de 4-7 dígitos (odómetros típicos: 00000–999999)
    const matches = raw.match(/\d{4,7}/g) || [];
    // Preferir el número más largo que sea razonable (< 2.000.000 km)
    const km = matches
      .map(n => parseInt(n, 10))
      .filter(n => n > 0 && n < 2000000)
      .sort((a, b) => String(b).length - String(a).length)[0] || null;
    res.json({ km: km ? String(km) : null });
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    res.status(500).json({ message: err.message });
  }
});

// OCR para código de barras (Tesseract con config de solo dígitos + regex EAN/UPC/Code128)
app.post('/api/ocr/barcode', memUpload.single('imagen'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Sin imagen' });
  const tmp = path.join(__dirname, 'public', 'uploads', `_barcode_${Date.now()}.jpg`);
  try {
    fs.writeFileSync(tmp, req.file.buffer);
    // Intentar con Tesseract en modo numérico
    const { data: { text } } = await Tesseract.recognize(tmp, 'eng', {
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '8'   // single word
    });
    fs.unlink(tmp, () => {});
    const raw = text.replace(/\D/g, '');
    // Patrones válidos: EAN-13 (13 dígitos), EAN-8 (8), UPC-A (12), Code128 variable
    const candidates = [];
    const m13 = raw.match(/\d{13}/g); if (m13) candidates.push(...m13);
    const m12 = raw.match(/\d{12}/g); if (m12) candidates.push(...m12);
    const m8  = raw.match(/\d{8}/g);  if (m8)  candidates.push(...m8);
    const m6  = raw.match(/\d{6,}/g); if (m6)  candidates.push(...m6);
    const barcode = candidates[0] || null;
    res.json({ barcode, raw_text: raw.substring(0, 30) });
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    res.status(500).json({ message: err.message });
  }
});

// OCR para comprobante de pago — extrae monto, fecha, destinatario, medio de pago
app.post('/api/ocr/comprobante', memUpload.single('comprobante'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Sin archivo' });
  try {
    const tmp = path.join(__dirname, 'public', 'uploads', `_comp_ocr_${Date.now()}${path.extname(req.file.originalname || '.jpg')}`);
    fs.writeFileSync(tmp, req.file.buffer);
    const preTmp2 = await preprocessForOCR(tmp);
    const { data: { text } } = await Tesseract.recognize(preTmp2, 'spa', {
      tessedit_pageseg_mode: '4', tessedit_ocr_engine_mode: '1',
    });
    fs.unlink(tmp, () => {});
    if (preTmp2 !== tmp) try { fs.unlinkSync(preTmp2); } catch(_) {}

    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const result = {
      monto: null, fecha: null, medio_pago: null, detalle: null, alias: null, banco: null,
      nro_transaccion: null, codigo_identificacion: null,
      nombre_origen: null, cuil_origen: null, cvu_origen: null,
      nombre_destino: null, cuil_destino: null, cbu_destino: null, banco_destino: null
    };

    // ── Monto ─────────────────────────────────────────────────────────────────
    // Helper: convierte "50.000,00" o "50.000" o "50 000" al número 50000
    const parseArsAmount = (s) => {
      if (!s) return 0;
      s = s.replace(/\s/g, '');
      let n;
      if (s.includes(',')) n = parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0;
      else if (/\.\d{3}$/.test(s)) n = parseFloat(s.replace(/\./g, '')) || 0;
      else n = parseFloat(s) || 0;
      // Descartar números que parecen CBU/CVU/CUIL (más de 9 dígitos significativos)
      const digits = String(Math.round(n)).replace(/^0+/, '').length;
      return digits <= 9 ? n : 0;
    };
    const montoPatterns = [
      /\$\s*([\d\.]+,\d{1,2})/,        // $ 50.000,00
      /\$\s*([\d\.]+)/,                 // $ 50.000
      /monto[:\s]+\$?\s*([\d\.,]+)/i,
      /importe[:\s]+\$?\s*([\d\.,]+)/i,
      /total[:\s]+\$?\s*([\d\.,]+)/i,
    ];
    for (const pat of montoPatterns) {
      const m = text.match(pat);
      if (m) {
        const n = parseArsAmount(m[1]);
        if (n >= 1) { result.monto = n; break; }
      }
    }
    // Limpiar CUIL/CUIT/CBU/CVU del texto para evitar que los dígitos se tomen como monto
    const textClean = text
      .replace(/\b\d{1,2}-\d{7,9}-\d\b/g, '')          // CUIL/CUIT: 20-24491146-4
      .replace(/\bC[VB]U[:\s]+\d+/gi, '')                // CVU/CBU etiquetados
      .replace(/\bCUIT\s*\/?\s*CUIL[:\s]*[\d\-]+/gi, '') // CUIT/CUIL etiquetados
      .replace(/\bDNI[:\s]+\d+/gi, '');                   // DNI etiquetados

    // Fallback línea sola: solo acepta formato argentino real (50.000 o 50.000,00 o 50000,00)
    // Excluye años (4 dígitos solos) y otros números sin formato de monto
    if (!result.monto) {
      for (const line of textClean.split('\n')) {
        const t = line.trim().replace(/^\$\s*/, '');
        const isArsMonto =
          /^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(t) ||  // 50.000 / 50.000,00
          /^\d+,\d{2}$/.test(t);                              // 50000,00
        if (isArsMonto) {
          const n = parseArsAmount(t);
          if (n >= 100) { result.monto = n; break; }
        }
      }
    }

    // ── Fecha + Hora ─────────────────────────────────────────────────────────
    // "Lunes, 15 de junio de 2026 a las 06:40 hs" → YYYY-MM-DD HH:MM
    const mesesES = { enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12 };
    const litMatch = text.match(/(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})(?:\s+a\s+las\s+(\d{1,2}:\d{2}))?/i);
    if (litMatch) {
      const mes = mesesES[litMatch[2].toLowerCase()];
      if (mes) {
        const dd = litMatch[1].padStart(2,'0'), mm = String(mes).padStart(2,'0'), yy = litMatch[3];
        const hh = litMatch[4] ? litMatch[4] : '00:00';
        result.fecha = `${yy}-${mm}-${dd} ${hh}:00`;
      }
    }
    if (!result.fecha) {
      const fechaHoraMatch = text.match(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})\s+(\d{2}:\d{2}(?::\d{2})?)/);
      const fechaSolaMatch = text.match(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
      if (fechaHoraMatch) {
        result.fecha = `${fechaHoraMatch[3]}-${fechaHoraMatch[2]}-${fechaHoraMatch[1]} ${fechaHoraMatch[4]}`;
      } else if (fechaSolaMatch) {
        result.fecha = `${fechaSolaMatch[3]}-${fechaSolaMatch[2]}-${fechaSolaMatch[1]}`;
      }
    }

    // ── Medio de pago → normalizado al select ────────────────────────────────
    const medioMap = [
      ['mercado pago', 'MercadoPago'], ['mercadopago', 'MercadoPago'],
      ['ual', 'Uala'], ['cocos', 'Cocos'],
      ['transferencia', 'Transferencia'],
      ['efectivo', 'Efectivo'], ['cheque', 'Cheque'],
      ['tarjeta', 'Tarjeta'],
    ];
    const txtLow = text.toLowerCase();
    for (const [key, val] of medioMap) {
      if (txtLow.includes(key)) { result.medio_pago = val; break; }
    }

    // ── Origen / Destino ─────────────────────────────────────────────────────
    // Buscar sección "De" y "Para" (o variantes)
    let seccionActual = null;
    const cuil_re = /(?:CUIL|CUIT|CUIL\/CUIT)[:\s]*([\d\-]+)/i;
    const cvu_re  = /CVU[:\s]*([\d]{16,22})/i;
    const cbu_re  = /CBU[:\s]*([\d]{16,22})/i;

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      const up = l.toUpperCase();
      // Detectar cambio de sección
      if (/^\*?\s*DE\s*$|^REMITENTE\s*$|^EMISOR\s*$/i.test(l)) { seccionActual = 'origen'; continue; }
      if (/^\*?\s*PARA\s*$|^DESTINATARIO\s*$|^RECEPTOR\s*$/i.test(l) || up.includes('O PARA') || up === 'PARA') { seccionActual = 'destino'; continue; }

      if (!seccionActual) continue;
      const dest = seccionActual === 'destino';

      // CUIL/CUIT
      const cm = l.match(cuil_re);
      if (cm) { if (dest) result.cuil_destino = cm[1]; else result.cuil_origen = cm[1]; continue; }
      // CVU
      const vm = l.match(cvu_re);
      if (vm) { if (dest) result.cbu_destino = vm[1]; else result.cvu_origen = vm[1]; continue; }
      // CBU
      const bm = l.match(cbu_re);
      if (bm) { if (dest) result.cbu_destino = bm[1]; else result.cvu_origen = bm[1]; continue; }
      // Banco destino
      if (dest && /^banco\s+\w/i.test(l)) { result.banco_destino = l.replace(/^banco\s*/i, '').trim(); continue; }
      // Nombre (línea que no es número ni keyword)
      if (/^[A-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]+$/.test(l) && l.length > 5 && l.split(' ').length >= 2) {
        if (dest && !result.nombre_destino) result.nombre_destino = l;
        if (!dest && !result.nombre_origen) result.nombre_origen = l;
      }
    }

    // ── Banco destino fallback ────────────────────────────────────────────────
    const bancosKnown = ['BNA','BANCO NACIÓN','BANCO DE LA CIUDAD','BANCO CIUDAD','SANTANDER','GALICIA','MACRO','BBVA','HSBC','ICBC','PATAGONIA','CREDICOOP','BRUBANK','NARANJA X'];
    if (!result.banco_destino) {
      for (const b of bancosKnown) {
        if (text.toUpperCase().includes(b)) { result.banco_destino = b; break; }
      }
    }
    result.banco = result.banco_destino;

    // ── Alias ─────────────────────────────────────────────────────────────────
    const aliasMatch = text.match(/\b([a-z][a-z0-9]{2,}\.[a-z0-9]+\.[a-z0-9]+)\b/i);
    if (aliasMatch) result.alias = aliasMatch[1].toLowerCase();

    // ── Número de operación ───────────────────────────────────────────────────
    for (let i = 0; i < lines.length; i++) {
      const up = lines[i].toUpperCase();
      if (up.includes('OPERACI') || up.includes('COMPROBANTE') || up.includes('N° DE') || up.includes('NRO DE')) {
        const val = (lines[i+1] || '').trim() || lines[i].replace(/.*[:\s]/,'').trim();
        if (val && /^\d{6,}$/.test(val)) { result.nro_transaccion = val; break; }
      }
    }
    // Fallback: número de 10+ dígitos en el texto
    if (!result.nro_transaccion) {
      const nroM = text.match(/\b(\d{10,20})\b/);
      if (nroM) result.nro_transaccion = nroM[1];
    }

    // ── Código de identificación (alfanumérico, MP style) ────────────────────
    for (let i = 0; i < lines.length; i++) {
      const up = lines[i].toUpperCase();
      if (up.includes('CÓDIGO DE IDENT') || up.includes('CODIGO DE IDENT') || up.includes('CÓDIGO DE IDENT')) {
        const val = (lines[i+1] || '').trim();
        if (val && /^[A-Z0-9]{8,}$/i.test(val)) { result.codigo_identificacion = val; break; }
      }
    }

    // ── Motivo ────────────────────────────────────────────────────────────────
    const motivoM = text.match(/motivo[:\s]+([^\n]+)/i);
    if (motivoM) result.detalle = motivoM[1].trim();

    res.json(result);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// -- Contactos alternativos del vehículo
app.get('/api/vehiculos/:id/contactos', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM vehiculo_contactos WHERE vehiculo_id = ?', [req.params.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/vehiculos/:id/contactos', async (req, res) => {
  const { nombre, celular, email } = req.body;
  if (!nombre) return res.status(400).json({ message: 'Nombre requerido' });
  try {
    const db = await getPool();
    const [r] = await db.query('INSERT INTO vehiculo_contactos (vehiculo_id, nombre, celular, email) VALUES (?,?,?,?)', [req.params.id, nombre, celular || null, email || null]);
    await registrarAuditoria(req, 'vehiculos', 'contacto-crear', req.params.id, `Contacto creado: ${nombre} — vehiculo_id=${req.params.id}`);
    res.status(201).json({ id: r.insertId });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/vehiculos/:id/contactos/:cid', async (req, res) => {
  try {
    const db = await getPool();
    const [[vc]] = await db.query('SELECT nombre FROM vehiculo_contactos WHERE id=?', [req.params.cid]);
    await db.query('DELETE FROM vehiculo_contactos WHERE id = ? AND vehiculo_id = ?', [req.params.cid, req.params.id]);
    await registrarAuditoria(req, 'vehiculos', 'contacto-eliminar', req.params.id, `Contacto eliminado: ${vc?.nombre||req.params.cid} — vehiculo_id=${req.params.id}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// -- Subir fotos del vehículo (cédulas + 4 fotos físicas) a R2
app.post('/api/vehiculos/:id/fotos', memUpload.fields([
  { name: 'cedula_frente', maxCount: 1 },
  { name: 'cedula_dorso', maxCount: 1 },
  { name: 'foto_frente', maxCount: 1 },
  { name: 'foto_lat_der', maxCount: 1 },
  { name: 'foto_lat_izq', maxCount: 1 },
  { name: 'foto_detras', maxCount: 1 },
]), async (req, res) => {
  try {
    const db = await getPool();
    const vid = req.params.id;
    const updates = {};

    const uploadField = async (field, dbCol, folder) => {
      const f = req.files?.[field]?.[0];
      if (f) updates[dbCol] = await uploadFile(f.buffer, f.originalname, folder);
    };

    await Promise.all([
      uploadField('cedula_frente', 'cedula_frente_url', `vehiculos/${vid}/cedulas`),
      uploadField('cedula_dorso', 'cedula_dorso_url', `vehiculos/${vid}/cedulas`),
      uploadField('foto_frente', 'foto_frente_url', `vehiculos/${vid}/fotos`),
      uploadField('foto_lat_der', 'foto_lat_der_url', `vehiculos/${vid}/fotos`),
      uploadField('foto_lat_izq', 'foto_lat_izq_url', `vehiculos/${vid}/fotos`),
      uploadField('foto_detras', 'foto_detras_url', `vehiculos/${vid}/fotos`),
    ]);

    if (Object.keys(updates).length) {
      const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      await db.query(`UPDATE vehiculos SET ${setClauses} WHERE id = ?`, [...Object.values(updates), vid]);
    }

    // También actualizar titular_email y titular_celular si vienen en body
    const { titular_email, titular_celular } = req.body;
    if (titular_email !== undefined || titular_celular !== undefined) {
      await db.query('UPDATE vehiculos SET titular_email=COALESCE(?,titular_email), titular_celular=COALESCE(?,titular_celular) WHERE id=?',
        [titular_email || null, titular_celular || null, vid]);
    }

    res.json({ ok: true, urls: updates });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// -- GNC mejorado (acepta multipart con oblea + campos extra)
app.post('/api/vehiculos/:id/gnc-upload', memUpload.single('oblea'), async (req, res) => {
  const { id } = req.params;
  const { vigencia_desde, vigencia_hasta, numero_oblea, regulador } = req.body;
  if (!vigencia_desde || !vigencia_hasta) return res.status(400).json({ message: 'Vigencias obligatorias' });
  try {
    const db = await getPool();
    let archivo_adjunto = null;
    if (req.file) archivo_adjunto = await uploadFile(req.file.buffer, req.file.originalname, `vehiculos/${id}/gnc`);

    // Cilindros: cil1..cil4 con campos _marca, _serie, _vto
    const cilCols = [], cilVals = [];
    for (let i = 1; i <= 4; i++) {
      const m = req.body[`cil${i}_marca`] || null;
      const s = req.body[`cil${i}_serie`] || null;
      const v = req.body[`cil${i}_vto`]   || null;
      if (m || s || v) {
        cilCols.push(`cil${i}_marca`, `cil${i}_serie`, `cil${i}_vto`);
        cilVals.push(m, s, v);
      }
    }
    const extraCols = cilCols.length ? ', ' + cilCols.join(', ') : '';
    const extraPlaceholders = cilCols.length ? ', ' + cilCols.map(() => '?').join(', ') : '';

    const [r] = await db.query(`
      INSERT INTO vehiculo_gnc (vehiculo_id, vigencia_desde, vigencia_hasta, numero_oblea, regulador, archivo_adjunto${extraCols})
      VALUES (?, ?, ?, ?, ?, ?${extraPlaceholders})
    `, [id, vigencia_desde, vigencia_hasta, numero_oblea || null, regulador || null, archivo_adjunto, ...cilVals]);

    // Alerta si vence en ≤60 días
    const diasHasta = Math.ceil((new Date(vigencia_hasta) - new Date()) / 86400000);
    if (diasHasta <= 60) {
      await db.query(`INSERT INTO alertas_vencimiento (vehiculo_id, tipo, referencia_id, mensaje, fecha_vencimiento) VALUES (?,?,?,?,?)`,
        [id, 'gnc', r.insertId, `GNC vence en ${diasHasta} días`, vigencia_hasta]);
    }

    const [[vehGncUp]] = await db.query('SELECT patente FROM vehiculos WHERE id=?', [id]);
    await registrarAuditoria(req, 'vehiculos', 'gnc_agregar', id, `GNC agregado para ${vehGncUp?.patente||id} — vigencia hasta ${vigencia_hasta}`);
    res.status(201).json({ message: 'GNC guardado', id: r.insertId });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// -- Seguros mejorado (acepta multipart con póliza + creación dinámica de aseguradora)
app.post('/api/vehiculos/:id/seguros-upload', memUpload.single('poliza'), async (req, res) => {
  const { id } = req.params;
  let { aseguradora_id, aseguradora_nombre, nro_poliza, vigencia_desde, vigencia_hasta } = req.body;
  if (!nro_poliza || !vigencia_desde || !vigencia_hasta) return res.status(400).json({ message: 'Póliza y vigencias obligatorias' });
  try {
    const db = await getPool();

    // Crear aseguradora al vuelo si no tiene id
    if (!aseguradora_id && aseguradora_nombre) {
      const [ex] = await db.query('SELECT id FROM aseguradoras WHERE LOWER(nombre)=LOWER(?)', [aseguradora_nombre]);
      if (ex.length) {
        aseguradora_id = ex[0].id;
      } else {
        const [nr] = await db.query('INSERT INTO aseguradoras (nombre) VALUES (?)', [aseguradora_nombre]);
        aseguradora_id = nr.insertId;
      }
    }
    if (!aseguradora_id) return res.status(400).json({ message: 'Aseguradora requerida' });

    let archivo_adjunto = null;
    if (req.file) archivo_adjunto = await uploadFile(req.file.buffer, req.file.originalname, `vehiculos/${id}/seguros`);

    const [r] = await db.query(`
      INSERT INTO vehiculo_seguros (vehiculo_id, aseguradora_id, nro_poliza, vigencia_desde, vigencia_hasta, archivo_adjunto)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [id, aseguradora_id, nro_poliza, vigencia_desde, vigencia_hasta, archivo_adjunto]);

    // Alerta si vence en ≤60 días
    const diasHasta = Math.ceil((new Date(vigencia_hasta) - new Date()) / 86400000);
    if (diasHasta <= 60) {
      await db.query(`INSERT INTO alertas_vencimiento (vehiculo_id, tipo, referencia_id, mensaje, fecha_vencimiento) VALUES (?,?,?,?,?)`,
        [id, 'seguro', r.insertId, `Seguro vence en ${diasHasta} días`, vigencia_hasta]);
    }

    const [[vehSegUp]] = await db.query('SELECT patente FROM vehiculos WHERE id=?', [id]);
    await registrarAuditoria(req, 'vehiculos', 'seguro_agregar', id, `Seguro agregado para ${vehSegUp?.patente||id} — póliza ${nro_poliza}, hasta ${vigencia_hasta}`);
    res.status(201).json({ message: 'Seguro guardado', id: r.insertId, aseguradora_id });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// -- OCR para documentos de chofer (Tesseract)
const uploadPersona = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, 'public', 'uploads', 'personas', req.params.id || 'tmp');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
    }
  })
});

app.post('/api/personas/:id/upload-docs', uploadPersona.fields([
  { name: 'dni_frente', maxCount: 1 },
  { name: 'dni_dorso',  maxCount: 1 },
]), async (req, res) => {
  try {
    const db = await getPool();
    const base = `/uploads/personas/${req.params.id}`;
    const updates = {};
    if (req.files?.dni_frente?.[0]) updates.dni_frente_url = `${base}/${req.files.dni_frente[0].filename}`;
    if (req.files?.dni_dorso?.[0])  updates.dni_dorso_url  = `${base}/${req.files.dni_dorso[0].filename}`;
    if (!Object.keys(updates).length) return res.json({ ok: true });
    const setParts = Object.keys(updates).map(k => `${k} = ?`);
    await db.query(`UPDATE personas SET ${setParts.join(', ')} WHERE id = ?`,
      [...Object.values(updates), req.params.id]);
    res.json({ ok: true, urls: updates });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

const uploadChofer = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, 'public', 'uploads', 'choferes', req.params.id || 'tmp');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
    }
  })
});

// Upload de documentos sin OCR — solo guardar archivos y actualizar URLs
app.post('/api/choferes/:id/upload-docs', uploadChofer.fields([
  { name: 'dni_frente', maxCount: 1 },
  { name: 'dni_dorso', maxCount: 1 },
  { name: 'registro_frente', maxCount: 1 },
  { name: 'registro_dorso', maxCount: 1 },
  { name: 'calif1', maxCount: 1 },
  { name: 'calif2', maxCount: 1 },
]), async (req, res) => {
  try {
    const db = await getPool();
    const base = `/uploads/choferes/${req.params.id}`;
    const updates = {};
    if (req.files?.dni_frente?.[0])       updates.dni_frente_url       = `${base}/${req.files.dni_frente[0].filename}`;
    if (req.files?.dni_dorso?.[0])        updates.dni_dorso_url        = `${base}/${req.files.dni_dorso[0].filename}`;
    if (req.files?.registro_frente?.[0])  updates.registro_frente_url  = `${base}/${req.files.registro_frente[0].filename}`;
    if (req.files?.registro_dorso?.[0])   updates.registro_dorso_url   = `${base}/${req.files.registro_dorso[0].filename}`;
    if (req.files?.calif1?.[0])           updates.calif1_url           = `${base}/${req.files.calif1[0].filename}`;
    if (req.files?.calif2?.[0])           updates.calif2_url           = `${base}/${req.files.calif2[0].filename}`;
    if (!Object.keys(updates).length) return res.json({ ok: true, urls: {} });
    const setParts = Object.keys(updates).map(k => `${k} = ?`);
    await db.query(`UPDATE choferes SET ${setParts.join(', ')} WHERE id = ?`,
      [...Object.values(updates), req.params.id]);
    res.json({ ok: true, urls: updates });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/ocr/chofer/:id?', uploadChofer.fields([
  { name: 'dni_frente', maxCount: 1 },
  { name: 'dni_dorso', maxCount: 1 },
  { name: 'registro_frente', maxCount: 1 },
  { name: 'registro_dorso', maxCount: 1 },
  { name: 'calif1', maxCount: 1 },
  { name: 'calif2', maxCount: 1 },
]), async (req, res) => {
  try {
    const result = {};
    const urlBase = '/uploads/choferes/' + (req.params.id || 'tmp');

    const ocrFile = async (field) => {
      const f = req.files?.[field]?.[0];
      if (!f) return null;
      const text = await ocrWithFallback(f.path, 'spa+eng');
      return { text, url: urlBase + '/' + f.filename };
    };

    const [dniFr, dniDo, regFr, regDo] = await Promise.all([
      ocrFile('dni_frente'), ocrFile('dni_dorso'),
      ocrFile('registro_frente'), ocrFile('registro_dorso')
    ]);

    if (dniFr) result.dni_frente_url = dniFr.url;
    if (dniDo) result.dni_dorso_url  = dniDo.url;
    if (regFr) result.registro_frente_url = regFr.url;
    if (regDo) result.registro_dorso_url  = regDo.url;

    // Debug: loguear texto extraído para diagnóstico
    console.log('[OCR-CHOFER] DNI frente:', dniFr?.text?.substring(0,300));
    console.log('[OCR-CHOFER] Reg frente:', regFr?.text?.substring(0,300));
    console.log('[OCR-CHOFER] Reg dorso:', regDo?.text?.substring(0,300));

    // ── Helpers de parsing ──────────────────────────────────────────────────
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const lines = (t) => (t || '').split('\n').map(l => l.trim()).filter(Boolean);

    const MESES = { ENE:1,JAN:1,FEB:2,MAR:3,ABR:4,APR:4,MAY:5,JUN:6,JUL:7,AGO:8,AUG:8,SEP:9,SET:9,OCT:10,NOV:11,DIC:12,DEC:12 };

    // Fecha: acepta DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY y DD MMM YYYY (ej: 30 SEP 1996)
    const toISO = (d) => {
      if (!d) return '';
      // formato numérico
      const m1 = d.match(/(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{4})/);
      if (m1) return `${m1[3]}-${m1[2].padStart(2,'0')}-${m1[1].padStart(2,'0')}`;
      // formato con mes abreviado: "30 SEP 1996", "3 DIC. 2027", "30SEP1996"
      const m2 = d.match(/(\d{1,2})\s*([A-Za-z]{3})\.?\s*(\d{4})/);
      if (m2) {
        const mes = MESES[m2[2].toUpperCase()];
        if (mes) return `${m2[3]}-${String(mes).padStart(2,'0')}-${m2[1].padStart(2,'0')}`;
      }
      return '';
    };

    // Extrae TODAS las fechas en cualquier formato
    const extractDates = (t) => {
      if (!t) return [];
      const pats = [
        /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/g,           // DD/MM/YYYY o DD-MM-YYYY
        /\d{1,2}\s*[A-Za-z]{3}\.?\s*\d{4}/g,           // DD MMM. YYYY (ej: 3 DIC. 2027, 30 SEP 1996)
      ];
      const found = [];
      pats.forEach(re => { const ms = t.match(re) || []; ms.forEach(m => { const iso = toISO(m); if (iso) found.push(iso); }); });
      return [...new Set(found)];
    };

    // DNI: 7-8 dígitos, descartar años (19xx/20xx)
    const extractDNI = (t) => {
      const nums = (t || '').match(/\b(\d{7,8})\b/g) || [];
      return nums.find(n => !n.match(/^(19|20)\d{2}/)) || nums[0] || '';
    };

    // Apellido y nombre — soporta "Apellido", "Last name", "First name", "Nombres"
    // Funciona con DNI (RENAPER) y Registro de Conducir (LNC argentina)
    const extractNombre = (frenteText) => {
      const ls = lines(frenteText);
      let apellido = '', nombre = '';
      const stripNonName = (s) => clean(s.replace(/[^A-ZÁÉÍÓÚÜÑ\s\-]/gi, '').trim());
      // Extrae el valor que viene DESPUÉS de la etiqueta en la misma línea
      // e.g. "1 Apellido / Last name LAINO" → "LAINO"
      const inlineVal = (line, afterLabel) => {
        const idx = line.toUpperCase().indexOf(afterLabel.toUpperCase());
        if (idx < 0) return '';
        const after = line.slice(idx + afterLabel.length).replace(/^[\s\/\-:]+/, '').trim();
        return after.length >= 2 ? stripNonName(after) : '';
      };

      for (let i = 0; i < ls.length; i++) {
        const up = ls[i].toUpperCase();
        const isApelLabel = up.includes('APELLIDO') || up.includes('LAST NAME') || up.includes('SURNAME');
        const isNomLabel  = (up.match(/\bNOMBRE[S]?\b/) || up.includes('FIRST NAME') || up.includes('GIVEN NAME') || up.includes('NAMES'))
                            && !up.includes('APELLIDO') && !up.includes('LAST');
        if (isApelLabel) {
          // Valor en línea siguiente
          if (ls[i+1]) apellido = stripNonName(ls[i+1]);
          // O valor en la misma línea (e.g. "Apellido / Last name LAINO")
          if (!apellido || apellido.length < 2) {
            const iv = inlineVal(ls[i], up.includes('LAST NAME') ? 'Last name' : 'APELLIDO');
            if (iv) apellido = iv;
          }
        }
        if (isNomLabel) {
          if (ls[i+1]) nombre = stripNonName(ls[i+1]);
          if (!nombre || nombre.length < 2) {
            const iv = inlineVal(ls[i], up.includes('FIRST NAME') ? 'First name' : 'NOMBRE');
            if (iv) nombre = iv;
          }
        }
      }
      // Fallback caps: líneas en MAYÚSCULAS sin dígitos, ≥4 chars (excluir palabras de labels)
      if (!apellido) {
        const skipWords = /^(REPUBLIC|ARGENTIN|NACIONAL|TIPO|SEXO|EJEMP|APELLID|NOMBRE|FIRST|LAST|SURNAME|GENDER|GIVEN|DOMICIL|MINISTERIO|TRANSPORT|ORGANISMO|LICENCIA|CONDUCIR|VIGENCIA|VENCIM|CLASS|CLASES?|HABILITAD)/;
        const caps = ls.filter(l => l.length >= 3 && l === l.toUpperCase() && /[A-ZÁÉÍÓÚ]{3}/.test(l) && !/\d/.test(l) && !skipWords.test(l.toUpperCase()));
        if (caps[0]) apellido = stripNonName(caps[0]);
        if (caps[1]) nombre   = stripNonName(caps[1]);
      }
      if (apellido && nombre) return `${apellido} ${nombre}`;
      return apellido || nombre || '';
    };

    // Domicilio desde dorso del DNI
    const extractDomicilio = (dorsoText) => {
      const ls = lines(dorsoText);
      for (let i = 0; i < ls.length; i++) {
        const up = ls[i].toUpperCase();
        if (up.includes('DOMICILIO') || up.includes('ADDRESS') || up.match(/DIRECCI[OÓ]N/)) {
          // Tomar las siguientes 1-2 líneas como dirección
          const parts = [];
          for (let j = i+1; j < Math.min(i+3, ls.length); j++) {
            const next = ls[j].trim();
            if (next.length > 3 && !next.toUpperCase().match(/^(FECHA|DATE|FIRMA|OBSERV|SEXO)/)) parts.push(next);
            else if (parts.length) break;
          }
          if (parts.length) return parts.join(', ');
        }
      }
      return '';
    };

    // Categoría del registro — captura múltiples: B.1 C.3 D.1 E.1 / B1C3D1E1 / B, C
    const extractCategoria = (regText) => {
      if (!regText) return '';

      // 1. Buscar después de etiqueta "Clase/Class/Clases" (frente de la licencia)
      const labelMatch = regText.match(/(?:clases?|class(?:es)?)\s*[\/]?\s*(?:class(?:es)?)?\s*[:\-]?\s*([A-E][\.0-9]*(?:[\s\-]*[A-E][\.0-9]*)*)/i);
      if (labelMatch) {
        // Extraer todos los códigos de esa cadena: "B.1 C.3 D.1 E.1" o "B.1C.3D.1E.1"
        const raw = labelMatch[1];
        const cats = [...raw.matchAll(/([A-E])\.?([1-9])/g)].map(m => `${m[1]}${m[2]}`);
        if (cats.length) return [...new Set(cats)].join(' ');
      }

      // 2. Buscar en el texto completo (frente + dorso) — formato A.N o AN
      //    Incluye patrones del dorso: "C.3  Camión sin...", "D.1  Automotores..."
      const allCats = [...regText.matchAll(/\b([A-E])\.?([1-9])\b/g)];
      if (allCats.length) {
        return [...new Set(allCats.map(m => `${m[1]}${m[2]}`))].join(' ');
      }

      // 3. Fallback: letras solas
      const simple = [...(regText.matchAll(/\b([A-E])\b/g))].map(m => m[1]);
      return [...new Set(simple)].slice(0, 6).join(' ');
    };

    // ── Aplicar parsers ────────────────────────────────────────────────────
    const dniText  = [dniFr?.text, dniDo?.text].filter(Boolean).join('\n');
    const regText  = [regFr?.text, regDo?.text].filter(Boolean).join('\n');

    // Nombre: DNI frente primero, fallback registro frente
    result.nombre = extractNombre(dniFr?.text || '') || extractNombre(regFr?.text || '');

    result.dni = extractDNI(dniText);

    // Fecha de nacimiento: buscar cerca de la etiqueta en DNI y Registro
    const currentYearNac = new Date().getFullYear();
    const isPlausibleNac = (iso) => iso && parseInt(iso.slice(0,4)) <= currentYearNac - 16 && parseInt(iso.slice(0,4)) >= 1920;
    const extractFechaNacimiento = (text) => {
      if (!text) return '';
      // Cerca de la etiqueta "Fecha de Nac." / "Date of birth" / "3."
      const nacMatch = text.match(/(?:3\.?\s*)?fecha\s*(?:de\s*)?nac[^\n]{0,40}\n?([\s\S]{0,80})/i)
                    || text.match(/date\s*of\s*birth[^\n]{0,30}\n?([\s\S]{0,80})/i);
      if (nacMatch) {
        const ds = extractDates(nacMatch[1]).filter(isPlausibleNac);
        if (ds.length) return ds[0];
      }
      // Fallback: primera fecha plausible como nacimiento (no futura, no muy reciente)
      return extractDates(text).find(isPlausibleNac) || '';
    };
    result.fecha_nacimiento = extractFechaNacimiento(dniText) || extractFechaNacimiento(regFr?.text || '') || '';

    const domicilio = extractDomicilio(dniDo?.text || '') || extractDomicilio(dniFr?.text || '');
    if (domicilio) result.domicilio = domicilio;

    if (regText) {
      result.registro_categoria = extractCategoria(regText);

      const currentYear = new Date().getFullYear();
      // Una fecha es plausible como vencimiento si su año es >= año actual - 2
      const isPlausibleVenc = (iso) => iso && parseInt(iso.slice(0,4)) >= currentYear - 2;

      // 1. Buscar cerca de etiquetas "4b", "Vencimiento", "Expires", "Vto."
      //    Captura los 120 chars siguientes al label (mismo renglón o siguiente)
      const vencLabelRe = /(?:4\s*[Bb]\.?\s*)?(?:vencimiento|vto\.?|expires?|expir[a-z]*)([\s\S]{0,120})/i;
      const vencLineMatch = regText.match(vencLabelRe);
      let vencDate = '';
      if (vencLineMatch) {
        // Solo hasta el primer salto de línea doble o 120 chars
        const nearby = vencLineMatch[1].split(/\n{2,}/)[0];
        const datesNearby = extractDates(nearby);
        vencDate = datesNearby.find(isPlausibleVenc) || '';
      }

      // 2. Fallback: mayor fecha plausible (excluye fechas de nacimiento del pasado lejano)
      if (!vencDate) {
        const regDates = extractDates(regText).filter(isPlausibleVenc);
        if (regDates.length) vencDate = regDates.sort().at(-1);
      }

      if (vencDate) result.registro_vencimiento = vencDate;
    }

    // Jurisdicción
    const provincias = ['BUENOS AIRES','CÓRDOBA','SANTA FE','MENDOZA','TUCUMÁN','ENTRE RÍOS','SALTA','MISIONES','CHACO','CORRIENTES','SANTIAGO DEL ESTERO','SAN JUAN','JUJUY','RÍO NEGRO','NEUQUÉN','FORMOSA','CHUBUT','SAN LUIS','CATAMARCA','LA RIOJA','LA PAMPA','TIERRA DEL FUEGO','SANTA CRUZ','C.A.B.A.','CABA'];
    const detectProv = (t) => t ? (provincias.find(p => t.toUpperCase().includes(p)) || null) : null;
    result.jurisdiccion_dni       = detectProv(dniText);
    result.jurisdiccion_registro  = detectProv(regText);

    // Incluir preview del texto OCR para diagnóstico en el frontend
    result._debug = {
      dni_frente_snippet: dniFr?.text?.substring(0, 200) || '',
      reg_frente_snippet: regFr?.text?.substring(0, 200) || '',
      reg_dorso_snippet:  regDo?.text?.substring(0, 200) || ''
    };
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// -- IA para documentos de chofer (Claude)
app.post('/api/ai/extract-chofer', memUpload.fields([
  { name: 'dni_frente', maxCount: 1 },
  { name: 'dni_dorso', maxCount: 1 },
  { name: 'registro_frente', maxCount: 1 },
  { name: 'registro_dorso', maxCount: 1 },
  { name: 'calif1', maxCount: 1 },
  { name: 'calif2', maxCount: 1 },
]), async (req, res) => {
  try {
    const buildImg = (f) => f ? { type: 'image', source: { type: 'base64', media_type: f.mimetype, data: f.buffer.toString('base64') } } : null;

    const imgs = [
      req.files?.dni_frente?.[0], req.files?.dni_dorso?.[0],
      req.files?.registro_frente?.[0], req.files?.registro_dorso?.[0]
    ].filter(Boolean).map(buildImg);

    if (!imgs.length) return res.status(400).json({ message: 'Se requiere al menos una imagen' });

    const resp = await callAI('extract-chofer', [{
      role: 'user', content: [
        { type: 'text', text: `Analizá estos documentos argentinos (DNI y/o Licencia Nacional de Conducir / Registro de Conducir). Extraé los datos y respondé ÚNICAMENTE con JSON válido sin texto adicional:
{
  "nombre": "",
  "dni": "",
  "cuil": "",
  "fecha_nacimiento": "",
  "domicilio": "",
  "provincia_dni": "",
  "registro_categoria": "",
  "registro_vencimiento": "",
  "provincia_registro": ""
}

Reglas importantes:
- "nombre": apellido y nombre completo del titular.
- "dni": número de DNI (solo dígitos, sin puntos).
- "fecha_nacimiento": campo etiquetado "Fecha de Nac.", "Date of birth" o campo 3 de la licencia. Formato YYYY-MM-DD.
- "registro_vencimiento": en la Licencia de Conducir es el campo "4b. Vencimiento / Expires" o "Válido hasta". NO es la fecha de nacimiento ni la de otorgamiento. Formato YYYY-MM-DD.
- "registro_categoria": clases habilitadas (ej: "B2 C3 D1", campo 9 "Clases/Class").
- "provincia_registro": jurisdicción emisora del registro (ej: "Buenos Aires - Lanus").
- Dejá vacío lo que no puedas leer con certeza. No confundas fechas entre sí.` },
        ...imgs
      ]
    }], { max_tokens: 512 });

    const data = JSON.parse(resp.content[0].text.trim());

    // Guardar archivos localmente
    const urlBase = '/uploads/choferes/' + (req.params.id || 'tmp');
    const saveLocal = async (field, buffer, mime) => {
      if (!buffer) return null;
      const ext = mime.split('/')[1] || 'jpg';
      const filename = field + '-' + Date.now() + '.' + ext;
      const dir = path.join(__dirname, 'public', 'uploads', 'choferes', req.params.id || 'tmp');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, filename), buffer);
      return urlBase + '/' + filename;
    };

    if (req.files?.dni_frente?.[0]) data.dni_frente_url = await saveLocal('dni_frente', req.files.dni_frente[0].buffer, req.files.dni_frente[0].mimetype);
    if (req.files?.dni_dorso?.[0]) data.dni_dorso_url = await saveLocal('dni_dorso', req.files.dni_dorso[0].buffer, req.files.dni_dorso[0].mimetype);
    if (req.files?.registro_frente?.[0]) data.registro_frente_url = await saveLocal('registro_frente', req.files.registro_frente[0].buffer, req.files.registro_frente[0].mimetype);
    if (req.files?.registro_dorso?.[0]) data.registro_dorso_url = await saveLocal('registro_dorso', req.files.registro_dorso[0].buffer, req.files.registro_dorso[0].mimetype);
    if (req.files?.calif1?.[0]) data.calif1_url = await saveLocal('calif1', req.files.calif1[0].buffer, req.files.calif1[0].mimetype);
    if (req.files?.calif2?.[0]) data.calif2_url = await saveLocal('calif2', req.files.calif2[0].buffer, req.files.calif2[0].mimetype);

    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// -- Guardar URLs de documentos en chofer
app.post('/api/choferes/:id/documentos', async (req, res) => {
  // campos con valor = URL nueva; campos con valor '__CLEAR__' = borrar; undefined/null = no tocar (COALESCE)
  const { dni_frente_url, dni_dorso_url, registro_frente_url, registro_dorso_url, registro_categoria, registro_vencimiento, calif1_url, calif2_url } = req.body;
  const resolve = (v) => v === '__CLEAR__' ? null : (v || null);
  const coalesce = (v, col) => v === '__CLEAR__' ? `${col} = NULL` : `${col} = COALESCE(?, ${col})`;
  try {
    const db = await getPool();
    const fields = [
      { val: dni_frente_url,      col: 'dni_frente_url' },
      { val: dni_dorso_url,       col: 'dni_dorso_url' },
      { val: registro_frente_url, col: 'registro_frente_url' },
      { val: registro_dorso_url,  col: 'registro_dorso_url' },
      { val: registro_categoria,  col: 'registro_categoria' },
      { val: registro_vencimiento,col: 'registro_vencimiento' },
      { val: calif1_url,          col: 'calif1_url' },
      { val: calif2_url,          col: 'calif2_url' },
    ];
    const setParts = []; const vals = [];
    fields.forEach(({ val, col }) => {
      if (val === undefined) return; // no incluir si no viene en el body
      if (val === '__CLEAR__') { setParts.push(`${col} = NULL`); }
      else { setParts.push(`${col} = COALESCE(?, ${col})`); vals.push(val || null); }
    });
    if (!setParts.length) return res.json({ ok: true });
    vals.push(req.params.id);
    await db.query(`UPDATE choferes SET ${setParts.join(', ')} WHERE id = ?`, vals);
    await registrarAuditoria(req, 'choferes', 'documentos-editar', req.params.id, `Documentos actualizados para chofer_id=${req.params.id}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// -- Alertas de vencimiento
app.get('/api/alertas', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query(`
      SELECT a.*, v.patente FROM alertas_vencimiento a
      JOIN vehiculos v ON a.vehiculo_id = v.id
      WHERE a.leida = 0
      ORDER BY a.fecha_vencimiento ASC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.patch('/api/alertas/:id/leida', async (req, res) => {
  try {
    const db = await getPool();
    await db.query('UPDATE alertas_vencimiento SET leida = 1 WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// -- Alertas consolidadas: se calculan en vivo (no dependen de un INSERT puntual que
// queda desactualizado con el tiempo) — VTV, Seguro, GNC, Registro de conductor, y
// Service por KM (proyectado con el promedio de km/día recorrido según Turnos).
app.get('/api/alertas/consolidado', async (req, res) => {
  try {
    const db = await getPool();
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    const diasHasta = (fecha) => fecha ? Math.ceil((new Date(fecha) - hoy) / 86400000) : null;
    const alertas = [];

    // VTV — última vigencia por vehículo
    const [vtvRows] = await db.query(`
      SELECT v.id AS vehiculo_id, v.patente, vt.vigencia_hasta
      FROM vehiculos v
      JOIN vehiculo_vtv vt ON vt.id = (
        SELECT id FROM vehiculo_vtv WHERE vehiculo_id = v.id ORDER BY vigencia_hasta DESC LIMIT 1
      )
    `);
    vtvRows.forEach(r => alertas.push({
      tipo: 'vtv', vehiculo_id: r.vehiculo_id, patente: r.patente,
      detalle: 'VTV', fecha_vencimiento: r.vigencia_hasta, dias: diasHasta(r.vigencia_hasta),
    }));

    // Seguro — última vigencia por vehículo
    const [segRows] = await db.query(`
      SELECT v.id AS vehiculo_id, v.patente, sg.vigencia_hasta
      FROM vehiculos v
      JOIN vehiculo_seguros sg ON sg.id = (
        SELECT id FROM vehiculo_seguros WHERE vehiculo_id = v.id ORDER BY vigencia_hasta DESC LIMIT 1
      )
    `);
    segRows.forEach(r => alertas.push({
      tipo: 'seguro', vehiculo_id: r.vehiculo_id, patente: r.patente,
      detalle: 'Seguro', fecha_vencimiento: r.vigencia_hasta, dias: diasHasta(r.vigencia_hasta),
    }));

    // GNC — último registro por vehículo; toma la fecha más próxima entre oblea general y los 4 cilindros
    const [gncRows] = await db.query(`
      SELECT v.id AS vehiculo_id, v.patente,
             g.vigencia_hasta, g.cil1_vto, g.cil2_vto, g.cil3_vto, g.cil4_vto
      FROM vehiculos v
      JOIN vehiculo_gnc g ON g.id = (
        SELECT id FROM vehiculo_gnc WHERE vehiculo_id = v.id ORDER BY vigencia_hasta DESC LIMIT 1
      )
    `);
    gncRows.forEach(r => {
      const fechas = [r.vigencia_hasta, r.cil1_vto, r.cil2_vto, r.cil3_vto, r.cil4_vto].filter(Boolean);
      if (!fechas.length) return;
      const masProxima = fechas.reduce((a,b) => new Date(a) < new Date(b) ? a : b);
      alertas.push({
        tipo: 'gnc', vehiculo_id: r.vehiculo_id, patente: r.patente,
        detalle: 'GNC (oblea/cilindro)', fecha_vencimiento: masProxima, dias: diasHasta(masProxima),
      });
    });

    // Registro de conductor
    const [choferRows] = await db.query(`
      SELECT id AS chofer_id, nombre, registro_vencimiento, telefono
      FROM choferes WHERE registro_vencimiento IS NOT NULL
    `);
    choferRows.forEach(r => alertas.push({
      tipo: 'registro', chofer_id: r.chofer_id, chofer_nombre: r.nombre,
      detalle: 'Registro de conductor', fecha_vencimiento: r.registro_vencimiento, dias: diasHasta(r.registro_vencimiento),
      wa_numero: r.telefono || null,
    }));

    // Service por KM — último service con "próximo service (km)" cargado, por vehículo + tipo.
    // Proyecta días restantes usando el promedio de km/día recorrido (Turnos, últimos 90 días).
    const [svcRows] = await db.query(`
      SELECT s.vehiculo_id, v.patente, s.tipo, s.fecha, s.km_proximo
      FROM services s
      JOIN vehiculos v ON v.id = s.vehiculo_id
      WHERE s.km_proximo IS NOT NULL
      AND s.id = (
        SELECT id FROM services s2
        WHERE s2.vehiculo_id = s.vehiculo_id AND s2.tipo = s.tipo AND s2.km_proximo IS NOT NULL
        ORDER BY s2.fecha DESC, s2.id DESC LIMIT 1
      )
    `);
    if (svcRows.length) {
      const vehiculoIds = [...new Set(svcRows.map(r => r.vehiculo_id))];
      const [kmActualRows] = await db.query(`
        SELECT t.vehiculo_id, t.km_fin
        FROM turnos t
        WHERE t.vehiculo_id IN (?) AND t.km_fin IS NOT NULL
        AND t.id = (
          SELECT id FROM turnos t2
          WHERE t2.vehiculo_id = t.vehiculo_id AND t2.km_fin IS NOT NULL
          ORDER BY COALESCE(t2.fecha_fin, t2.fecha_inicio) DESC LIMIT 1
        )
      `, [vehiculoIds]);
      const kmActualMap = Object.fromEntries(kmActualRows.map(r => [r.vehiculo_id, parseFloat(r.km_fin)]));

      const [promedioRows] = await db.query(`
        SELECT vehiculo_id, SUM(recorrido) AS km_total,
               GREATEST(DATEDIFF(MAX(COALESCE(fecha_fin, fecha_inicio)), MIN(fecha_inicio)), 1) AS dias_periodo
        FROM turnos
        WHERE vehiculo_id IN (?) AND recorrido IS NOT NULL
        AND fecha_inicio >= (NOW() - INTERVAL 90 DAY)
        GROUP BY vehiculo_id
      `, [vehiculoIds]);
      const promedioMap = Object.fromEntries(promedioRows.map(r => [r.vehiculo_id, parseFloat(r.km_total) / r.dias_periodo]));

      svcRows.forEach(r => {
        const kmActual = kmActualMap[r.vehiculo_id];
        const kmPromedioDia = promedioMap[r.vehiculo_id];
        const kmProximo = parseFloat(r.km_proximo);
        const kmRestante = kmActual != null ? kmProximo - kmActual : null;
        const diasEstimados = (kmRestante != null && kmPromedioDia > 0) ? Math.ceil(kmRestante / kmPromedioDia) : null;
        alertas.push({
          tipo: 'service', vehiculo_id: r.vehiculo_id, patente: r.patente,
          detalle: r.tipo || 'Service', km_proximo: kmProximo, km_actual: kmActual ?? null,
          km_restante: kmRestante, dias: diasEstimados,
          sinDato: kmActual == null ? 'sin_km_actual' : (kmPromedioDia > 0 ? null : 'sin_promedio_km'),
        });
      });
    }

    // Certificados AFIP — cert_vence de afip_contribuyentes
    const [certRows] = await db.query(
      `SELECT id, cuit, nombre, cert_vence FROM afip_contribuyentes WHERE activo=1 AND cert_vence IS NOT NULL`);
    certRows.forEach(r => alertas.push({
      tipo: 'afip_cert', afip_id: r.id,
      detalle: `Cert AFIP ${r.nombre} (${r.cuit})`,
      fecha_vencimiento: r.cert_vence,
      dias: diasHasta(r.cert_vence),
    }));

    // Multas pendientes — vto. voluntario o total dentro de 20 días (o ya vencidas)
    const [multaRows] = await db.query(`
      SELECT m.id, m.numero_acta, m.descripcion, m.monto_voluntario, m.monto_total,
             m.fecha_vto_voluntario, m.fecha_vto_total, m.fecha_vencimiento,
             v.id AS vehiculo_id, v.patente
      FROM multas m
      JOIN vehiculos v ON v.id = m.vehiculo_id
      WHERE m.estado = 'pendiente'
        AND (
          (m.fecha_vto_voluntario IS NOT NULL AND DATEDIFF(m.fecha_vto_voluntario, CURDATE()) <= 20)
          OR (m.fecha_vto_total    IS NOT NULL AND DATEDIFF(m.fecha_vto_total,    CURDATE()) <= 20)
          OR (m.fecha_vto_voluntario IS NULL AND m.fecha_vto_total IS NULL
              AND m.fecha_vencimiento IS NOT NULL AND DATEDIFF(m.fecha_vencimiento, CURDATE()) <= 20)
        )
    `);
    multaRows.forEach(r => {
      // Vto. voluntario
      const fVol = r.fecha_vto_voluntario || r.fecha_vencimiento;
      const diasVol = diasHasta(fVol);
      if (fVol) alertas.push({
        tipo: 'multa', subtipo: 'voluntario',
        vehiculo_id: r.vehiculo_id, patente: r.patente, multa_id: r.id,
        detalle: `${r.numero_acta ? 'Acta ' + r.numero_acta + ' · ' : ''}${r.descripcion || 'Multa'} — Pago voluntario${r.monto_voluntario ? ' $' + parseFloat(r.monto_voluntario).toLocaleString('es-AR') : ''}`,
        fecha_vencimiento: fVol, dias: diasVol,
      });
      // Vto. total (si existe y es distinto al voluntario)
      if (r.fecha_vto_total && r.fecha_vto_total !== r.fecha_vto_voluntario) {
        alertas.push({
          tipo: 'multa', subtipo: 'total',
          vehiculo_id: r.vehiculo_id, patente: r.patente, multa_id: r.id,
          detalle: `${r.numero_acta ? 'Acta ' + r.numero_acta + ' · ' : ''}${r.descripcion || 'Multa'} — Pago total${r.monto_total ? ' $' + parseFloat(r.monto_total).toLocaleString('es-AR') : ''}`,
          fecha_vencimiento: r.fecha_vto_total, dias: diasHasta(r.fecha_vto_total),
        });
      }
    });

    // Ordenar: primero lo que ya venció o tiene fecha/estimación (asc), lo sin-dato al final
    alertas.sort((a,b) => {
      if (a.dias == null && b.dias == null) return 0;
      if (a.dias == null) return 1;
      if (b.dias == null) return -1;
      return a.dias - b.dias;
    });

    res.json(alertas);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Mensajes programados (recordatorios WA) ──────────────────────────────────

app.get('/api/wa/programados', requireAuth, async (req, res) => {
  try {
    const db = await getPool();
    await db.query(`CREATE TABLE IF NOT EXISTS wa_mensajes_programados (
      id INT AUTO_INCREMENT PRIMARY KEY,
      mensaje TEXT NOT NULL,
      destinatarios_tipo VARCHAR(20) NOT NULL,
      destinatarios JSON NOT NULL,
      fecha_hora DATETIME NOT NULL,
      repeticion VARCHAR(20) DEFAULT 'none',
      estado VARCHAR(20) DEFAULT 'pendiente',
      error_msg TEXT,
      created_at DATETIME DEFAULT NOW()
    )`);
    // Agregar columna repeticion si la tabla ya existía sin ella
    await db.query(`ALTER TABLE wa_mensajes_programados ADD COLUMN IF NOT EXISTS repeticion VARCHAR(20) DEFAULT 'none'`).catch(()=>{});
    const [rows] = await db.query('SELECT * FROM wa_mensajes_programados ORDER BY fecha_hora ASC');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/wa/programados', requireAuth, async (req, res) => {
  try {
    const db = await getPool();
    const { mensaje, destinatarios_tipo, destinatarios, fecha_hora, repeticion = 'none' } = req.body;
    if (!mensaje || !destinatarios_tipo || !destinatarios?.length || !fecha_hora)
      return res.status(400).json({ message: 'Faltan campos requeridos' });
    await db.query(
      'INSERT INTO wa_mensajes_programados (mensaje, destinatarios_tipo, destinatarios, fecha_hora, repeticion) VALUES (?,?,?,?,?)',
      [mensaje, destinatarios_tipo, JSON.stringify(destinatarios), fecha_hora, repeticion]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put('/api/wa/programados/:id', requireAuth, async (req, res) => {
  try {
    const db = await getPool();
    const { mensaje, destinatarios_tipo, destinatarios, fecha_hora, repeticion = 'none' } = req.body;
    if (!mensaje || !fecha_hora) return res.status(400).json({ message: 'Faltan campos' });
    await db.query(
      'UPDATE wa_mensajes_programados SET mensaje=?, destinatarios_tipo=?, destinatarios=?, fecha_hora=?, repeticion=?, estado=\'pendiente\', error_msg=NULL WHERE id=?',
      [mensaje, destinatarios_tipo, JSON.stringify(destinatarios), fecha_hora, repeticion, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/wa/programados/:id', requireAuth, async (req, res) => {
  try {
    const db = await getPool();
    await db.query('DELETE FROM wa_mensajes_programados WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Loop de envío de mensajes programados (cada 60 segundos)
async function _procesarMensajesProgramados() {
  try {
    const db = await getPool();
    const [[exists]] = await db.query("SHOW TABLES LIKE 'wa_mensajes_programados'");
    if (!exists) return;
    const [pendientes] = await db.query(
      "SELECT * FROM wa_mensajes_programados WHERE estado='pendiente' AND fecha_hora <= NOW()"
    );
    for (const m of pendientes) {
      try {
        const { MessageMedia } = require('whatsapp-web.js');
        const sess = waSessions.get('default');
        if (!sess?.ready) throw new Error('Bot WA no conectado');
        const client = sess.client;
        const dests = typeof m.destinatarios === 'string' ? JSON.parse(m.destinatarios) : m.destinatarios;
        let errores = 0;
        for (const d of dests) {
          try {
            const chatId = await _resolveWaChatId(client, d.chatId || d.id || '');
            const texto = d.patente ? m.mensaje.replace(/\{patente\}/gi, d.patente) : m.mensaje;
            await client.sendMessage(chatId, texto);
            await new Promise(r => setTimeout(r, 1000));
          } catch { errores++; }
        }
        const estadoFinal = errores === dests.length ? 'error' : 'enviado';
        await db.query(
          "UPDATE wa_mensajes_programados SET estado=?, error_msg=? WHERE id=?",
          [estadoFinal, errores ? `${errores} destinos fallaron` : null, m.id]
        );
        // Reprogramar si tiene repetición
        if (estadoFinal === 'enviado' && m.repeticion && m.repeticion !== 'none') {
          const base = new Date(m.fecha_hora);
          if (m.repeticion === 'daily')   base.setDate(base.getDate() + 1);
          else if (m.repeticion === 'weekly')  base.setDate(base.getDate() + 7);
          else if (m.repeticion === 'monthly') base.setMonth(base.getMonth() + 1);
          const _p = n => String(n).padStart(2,'0');
          const next = `${base.getFullYear()}-${_p(base.getMonth()+1)}-${_p(base.getDate())} ${_p(base.getHours())}:${_p(base.getMinutes())}:${_p(base.getSeconds())}`;
          await db.query(
            'INSERT INTO wa_mensajes_programados (mensaje, destinatarios_tipo, destinatarios, fecha_hora, repeticion) VALUES (?,?,?,?,?)',
            [m.mensaje, m.destinatarios_tipo, typeof m.destinatarios === 'string' ? m.destinatarios : JSON.stringify(m.destinatarios), next, m.repeticion]
          );
        }
      } catch (err) {
        await db.query("UPDATE wa_mensajes_programados SET estado='error', error_msg=? WHERE id=?", [err.message, m.id]);
      }
    }
  } catch (_) {}
}
setInterval(_procesarMensajesProgramados, 60000);

startApp();

