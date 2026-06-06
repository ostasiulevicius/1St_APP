const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'flota.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS vehicles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patente TEXT UNIQUE,
    titular_nombre TEXT,
    titular_domicilio TEXT,
    chasis TEXT,
    motor TEXT,
    marca TEXT,
    modelo TEXT,
    anio INTEGER,
    color TEXT,
    email TEXT,
    celular TEXT,
    cedula_frente_url TEXT,
    cedula_dorso_url TEXT,
    foto_frente_url TEXT,
    foto_lateral_der_url TEXT,
    foto_lateral_izq_url TEXT,
    foto_detras_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS vehicle_contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id INTEGER NOT NULL,
    nombre TEXT,
    celular TEXT,
    email TEXT,
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS gnc_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id INTEGER NOT NULL,
    numero_oblea TEXT,
    regulador TEXT,
    fecha_vencimiento TEXT,
    archivo_url TEXT,
    alerta_generada INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS insurance_companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS insurance_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id INTEGER NOT NULL,
    company_id INTEGER NOT NULL,
    numero_poliza TEXT,
    vigencia_desde TEXT,
    vigencia_hasta TEXT,
    archivo_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE,
    FOREIGN KEY (company_id) REFERENCES insurance_companies(id)
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id INTEGER NOT NULL,
    tipo TEXT NOT NULL,
    referencia_id INTEGER,
    mensaje TEXT,
    fecha_vencimiento TEXT,
    leida INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
  );
`);

module.exports = db;
