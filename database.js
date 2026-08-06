require('dotenv').config();
const mysql = require('mysql2/promise');

const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : '',
};

let pool;

async function getPool() {
  if (pool) return pool;

  try {
    const tempConnection = await mysql.createConnection(dbConfig);
    const dbName = process.env.DB_NAME || 'flota';
    
    console.log(`[DB] Conectado al servidor MySQL. Verificando base de datos "${dbName}"...`);
    await tempConnection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    await tempConnection.end();

    pool = mysql.createPool({
      ...dbConfig,
      database: dbName,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    console.log(`[DB] Pool de conexiones creado con éxito para la base de datos "${dbName}".`);
    return pool;
  } catch (error) {
    console.error('[DB] Error al inicializar la conexión con MySQL:', error.message);
    throw error;
  }
}

async function initializeDatabase() {
  try {
    const db = await getPool();

    console.log('[DB] Inicializando tablas...');

    // 1. Tabla de Condiciones Fiscales (ARCA/AFIP)
    await db.query(`
      CREATE TABLE IF NOT EXISTS condiciones_fiscales (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL UNIQUE
      ) ENGINE=InnoDB;
    `);
    console.log('[DB] Tabla "condiciones_fiscales" verificada/creada.');

    // Sembrar valores por defecto para condiciones fiscales si está vacía
    const [cfCount] = await db.query('SELECT COUNT(*) as count FROM condiciones_fiscales');
    if (cfCount[0].count === 0) {
      const condiciones = [
        ['Responsable Inscripto'],
        ['Monotributista'],
        ['IVA Exento'],
        ['Consumidor Final'],
        ['No Categorizado']
      ];
      await db.query('INSERT INTO condiciones_fiscales (nombre) VALUES ?', [condiciones]);
      console.log('[DB] Tabla "condiciones_fiscales" poblada con valores estándar de ARCA.');
    }

    // 2. Tabla de Cuentas Financieras del Propietario
    await db.query(`
      CREATE TABLE IF NOT EXISTS cuentas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        alias VARCHAR(100) NOT NULL UNIQUE,
        titular VARCHAR(255) NOT NULL,
        dni_cuit VARCHAR(50) NULL,
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);
    console.log('[DB] Tabla "cuentas" verificada/creada.');

    // 3. Tabla de Choferes
    await db.query(`
      CREATE TABLE IF NOT EXISTS choferes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        telefono VARCHAR(50) UNIQUE,
        dni VARCHAR(50) NULL,
        cuil VARCHAR(50) NULL,
        email VARCHAR(100) NULL,
        domicilio VARCHAR(255) NULL,
        modalidad VARCHAR(100) NULL,
        fecha_nacimiento DATE NULL,
        condicion_fiscal_id INT NULL,
        foto_chofer VARCHAR(255) NULL,
        foto_dni VARCHAR(255) NULL,
        foto_registro VARCHAR(255) NULL,
        activo TINYINT DEFAULT 1,
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (condicion_fiscal_id) REFERENCES condiciones_fiscales(id) ON DELETE SET NULL
      ) ENGINE=InnoDB;
    `);
    console.log('[DB] Tabla "choferes" verificada/creada.');

    // 4. Tabla de Marcas de Autos (DNRPA)
    await db.query(`
      CREATE TABLE IF NOT EXISTS marcas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL UNIQUE
      ) ENGINE=InnoDB;
    `);
    console.log('[DB] Tabla "marcas" verificada/creada.');

    // 5. Tabla de Modelos de Autos (DNRPA)
    await db.query(`
      CREATE TABLE IF NOT EXISTS modelos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        marca_id INT NOT NULL,
        nombre VARCHAR(150) NOT NULL,
        FOREIGN KEY (marca_id) REFERENCES marcas(id) ON DELETE CASCADE,
        UNIQUE KEY unique_modelo_marca (marca_id, nombre)
      ) ENGINE=InnoDB;
    `);
    console.log('[DB] Tabla "modelos" verificada/creada.');

    // 6. Tabla de Aseguradoras (Superintendencia de Seguros de la Nación - SSN)
    await db.query(`
      CREATE TABLE IF NOT EXISTS aseguradoras (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(155) NOT NULL UNIQUE
      ) ENGINE=InnoDB;
    `);
    console.log('[DB] Tabla "aseguradoras" verificada/creada.');

    // Sembrar valores por defecto para aseguradoras si está vacía
    const [asegCount] = await db.query('SELECT COUNT(*) as count FROM aseguradoras');
    if (asegCount[0].count === 0) {
      const aseguradoras = [
        ['Federación Patronal Seguros S.A.'],
        ['La Caja de Ahorro y Seguro'],
        ['Sancor Cooperativa de Seguros Limitada'],
        ['Seguros Rivadavia'],
        ['La Mercantil Andina S.A.'],
        ['San Cristóbal Seguros'],
        ['La Segunda Seguros'],
        ['Zurich Aseguradora Argentina S.A.'],
        ['Allianz Argentina S.A.'],
        ['Berkley International Seguros S.A.'],
        ['Rio Uruguay Seguros (RUS)'],
        ['Mercosur Seguros'],
        ['Mapfre Argentina Seguros S.A.'],
        ['Prudential Seguros'],
        ['Orbis Seguros']
      ];
      await db.query('INSERT INTO aseguradoras (nombre) VALUES ?', [aseguradoras]);
      console.log('[DB] Tabla "aseguradoras" poblada con compañías oficiales de la SSN.');
    }

    // Ampliar aseguradoras con datos completos
    await db.query(`ALTER TABLE aseguradoras ADD COLUMN IF NOT EXISTS cuit VARCHAR(20) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE aseguradoras ADD COLUMN IF NOT EXISTS web VARCHAR(255) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE aseguradoras ADD COLUMN IF NOT EXISTS domicilio VARCHAR(300) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE aseguradoras ADD COLUMN IF NOT EXISTS telefono VARCHAR(80) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE aseguradoras ADD COLUMN IF NOT EXISTS email VARCHAR(150) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE aseguradoras ADD COLUMN IF NOT EXISTS notas TEXT NULL`).catch(()=>{});
    await db.query(`ALTER TABLE aseguradoras ADD COLUMN IF NOT EXISTS lat DECIMAL(10,7) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE aseguradoras ADD COLUMN IF NOT EXISTS lng DECIMAL(10,7) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE aseguradoras ADD COLUMN IF NOT EXISTS codigo_postal VARCHAR(20) NULL`).catch(()=>{});

    // Tabla de contactos de aseguradoras
    await db.query(`
      CREATE TABLE IF NOT EXISTS aseguradoras_contactos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        aseguradora_id INT NOT NULL,
        nombre VARCHAR(100) NOT NULL,
        cargo VARCHAR(100) NULL,
        telefono VARCHAR(50) NULL,
        celular VARCHAR(50) NULL,
        email VARCHAR(150) NULL,
        FOREIGN KEY (aseguradora_id) REFERENCES aseguradoras(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `).catch(()=>{});
    console.log('[DB] Tabla "aseguradoras_contactos" verificada/creada.');

    // 7. Tabla de Vehículos (Autos)
    await db.query(`
      CREATE TABLE IF NOT EXISTS vehiculos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        patente VARCHAR(50) UNIQUE NOT NULL,
        marca VARCHAR(100) NULL, -- Guardamos marcas anteriores para compatibilidad
        modelo VARCHAR(100) NULL, -- Guardamos modelos anteriores para compatibilidad
        modelo_id INT NULL,
        color VARCHAR(50) NULL,
        nro_motor VARCHAR(100) NULL,
        nro_chasis VARCHAR(100) NULL,
        telepeaje_tag VARCHAR(100) NULL,
        telepeaje_responsable VARCHAR(50) DEFAULT 'propietario', -- 'propietario' o 'chofer'
        activo TINYINT DEFAULT 1,
        fecha_alta DATE NULL,
        fecha_baja DATE NULL,
        motivo_baja TEXT NULL,
        foto_principal VARCHAR(255) NULL, -- Foto/Cedula principal
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (modelo_id) REFERENCES modelos(id) ON DELETE SET NULL
      ) ENGINE=InnoDB;
    `);
    console.log('[DB] Tabla "vehiculos" verificada/creada.');

    // 5. Tabla de Fotos de Vehículos (4 lados)
    await db.query(`
      CREATE TABLE IF NOT EXISTS vehiculo_fotos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vehiculo_id INT NOT NULL,
        lado VARCHAR(50) NOT NULL, -- 'frente', 'atras', 'lateral_derecho', 'lateral_izquierdo'
        foto_url VARCHAR(255) NOT NULL,
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log('[DB] Tabla "vehiculo_fotos" verificada/creada.');

    // 6. Tabla de Proveedores (Mecánicos, repuestos, etc.)
    await db.query(`
      CREATE TABLE IF NOT EXISTS proveedores (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL UNIQUE,
        cuit VARCHAR(50) NULL,
        telefono VARCHAR(50) NULL,
        direccion VARCHAR(255) NULL,
        rubro VARCHAR(100) NULL,
        activo TINYINT DEFAULT 1,
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);
    console.log('[DB] Tabla "proveedores" verificada/creada.');

    // 7. Tabla de Services Realizados (Mantenimiento)
    await db.query(`
      CREATE TABLE IF NOT EXISTS services (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vehiculo_id INT NOT NULL,
        proveedor_id INT NULL,
        fecha DATE NOT NULL,
        trabajo_realizado TEXT NOT NULL,
        costo_materiales DECIMAL(10,2) DEFAULT 0.00,
        costo_mano_obra DECIMAL(10,2) DEFAULT 0.00,
        kms INT NULL,
        proximo_service_kms INT NULL,
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id) ON DELETE CASCADE,
        FOREIGN KEY (proveedor_id) REFERENCES proveedores(id) ON DELETE SET NULL
      ) ENGINE=InnoDB;
    `);
    console.log('[DB] Tabla "services" verificada/creada.');

    // 8. Tabla de Multas (Infracciones de Tránsito)
    await db.query(`
      CREATE TABLE IF NOT EXISTS multas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vehiculo_id INT NOT NULL,
        chofer_id INT NULL,
        fecha_infraccion TIMESTAMP NULL,
        descripcion TEXT NOT NULL,
        monto DECIMAL(10,2) DEFAULT 0.00,
        estado VARCHAR(50) DEFAULT 'pendiente', -- 'pendiente', 'pagada', 'apelada'
        archivo_adjunto VARCHAR(255) NULL, -- ruta/nombre del archivo PDF o Video
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id) ON DELETE CASCADE,
        FOREIGN KEY (chofer_id) REFERENCES choferes(id) ON DELETE SET NULL
      ) ENGINE=InnoDB;
    `);
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS fecha_pago DATE NULL`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS monto_voluntario DECIMAL(12,2) NULL COMMENT 'Importe con bonificación voluntaria'`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS fecha_vto_voluntario DATE NULL COMMENT 'Vencimiento pago voluntario'`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS monto_total DECIMAL(12,2) NULL COMMENT 'Importe pago total sin bonificación'`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS fecha_vto_total DATE NULL COMMENT 'Vencimiento pago total'`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS medio_pago_multa VARCHAR(50) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS nro_operacion_pago VARCHAR(100) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS comprobante_pago_url VARCHAR(255) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS cuenta_id_pago INT NULL`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS tarjeta_id_pago INT NULL`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS cuotas_pago INT NULL DEFAULT 1`).catch(()=>{});
    console.log('[DB] Tabla "multas" verificada/creada.');

    await db.query(`ALTER TABLE service_pagos ADD COLUMN IF NOT EXISTS comprobante_url VARCHAR(500) NULL`).catch(()=>{});

    // Auditoría de verificaciones de multas por vehículo/municipalidad
    await db.query(`
      CREATE TABLE IF NOT EXISTS multa_verificacion_log (
        id                 INT AUTO_INCREMENT PRIMARY KEY,
        vehiculo_id        INT NOT NULL,
        municipalidad_id   INT NOT NULL,
        fecha              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resultado          ENUM('sin_multas','con_multas','error','cancelado') DEFAULT 'sin_multas',
        multas_encontradas INT DEFAULT 0,
        multas_importadas  INT DEFAULT 0,
        usuario            VARCHAR(100) NULL,
        INDEX idx_vehi_muni (vehiculo_id, municipalidad_id),
        INDEX idx_fecha (fecha)
      ) ENGINE=InnoDB;
    `);

    // 9. Tabla de Bancos (Argentina)
    await db.query(`
      CREATE TABLE IF NOT EXISTS bancos (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        nombre      VARCHAR(255) NOT NULL UNIQUE,
        codigo_bcra VARCHAR(10)  NULL,
        cvu_prefix  VARCHAR(20)  NULL,
        tipo        ENUM('banco','fintech','billetera') NOT NULL DEFAULT 'banco',
        logo_emoji  VARCHAR(10)  NULL
      ) ENGINE=InnoDB;
    `);
    // Migración: agregar columnas nuevas si la tabla ya existía sin ellas
    await db.query(`ALTER TABLE bancos ADD COLUMN IF NOT EXISTS cvu_prefix VARCHAR(20) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE bancos ADD COLUMN IF NOT EXISTS tipo ENUM('banco','fintech','billetera') NOT NULL DEFAULT 'banco'`).catch(()=>{});
    await db.query(`ALTER TABLE bancos ADD COLUMN IF NOT EXISTS logo_emoji VARCHAR(10) NULL`).catch(()=>{});
    console.log('[DB] Tabla "bancos" verificada/creada.');

    // Limpiar registros del seed viejo (nombres legacy que quedaron duplicados)
    await db.query(`
      DELETE FROM bancos WHERE nombre IN (
        'Banco de la Nación Argentina','Banco de la Provincia de Buenos Aires',
        'Banco Santander Argentina','HSBC Bank Argentina','Banco Ciudad de Buenos Aires',
        'UNINVERC S.A. cREDITcAR','Banco Santander Argentina S.A.'
      )
    `).catch(()=>{});

    // Sembrar bancos y fintechs (upsert por nombre único)
    await db.query(`
      INSERT INTO bancos (nombre, codigo_bcra, cvu_prefix, tipo, logo_emoji) VALUES
        ('Banco Nación (BNA)',             '011', NULL,       'banco',    '🏦'),
        ('Banco Provincia (BAPRO)',        '014', NULL,       'banco',    '🏦'),
        ('Banco Galicia',                  '007', NULL,       'banco',    '🏦'),
        ('Banco Santander',                '072', NULL,       'banco',    '🏦'),
        ('BBVA Argentina',                 '017', NULL,       'banco',    '🏦'),
        ('HSBC Argentina',                 '150', NULL,       'banco',    '🏦'),
        ('Banco Macro',                    '285', NULL,       'banco',    '🏦'),
        ('ICBC Argentina',                 '015', NULL,       'banco',    '🏦'),
        ('Banco Ciudad (BCBA)',            '029', NULL,       'banco',    '🏦'),
        ('Banco Patagonia',                '034', NULL,       'banco',    '🏦'),
        ('Banco Supervielle',              '027', NULL,       'banco',    '🏦'),
        ('Banco Hipotecario',              '044', NULL,       'banco',    '🏦'),
        ('Banco Credicoop',                '191', NULL,       'banco',    '🏦'),
        ('Banco Comafi',                   '299', NULL,       'banco',    '🏦'),
        ('BIND (Banco Industrial)',         '322', NULL,       'banco',    '🏦'),
        ('Banco Itaú Argentina',           '259', NULL,       'banco',    '🏦'),
        ('Banco Coinag',                   '431', NULL,       'banco',    '🏦'),
        ('MercadoPago',                    NULL,  '00000031', 'fintech',  '💙'),
        ('Ualá',                           NULL,  '00000070', 'fintech',  '🟣'),
        ('Brubank',                        NULL,  '00000140', 'fintech',  '🔵'),
        ('Naranja X',                      NULL,  '00000026', 'fintech',  '🟠'),
        ('Personal Pay',                   NULL,  '00000060', 'fintech',  '📱'),
        ('Modo',                           NULL,  '00000025', 'fintech',  '🔷'),
        ('Lemon Cash',                     NULL,  '00000047', 'fintech',  '🍋'),
        ('Cocos Pay',                      NULL,  '00000063', 'fintech',  '🥥'),
        ('Prex',                           NULL,  '00000016', 'fintech',  '💳'),
        ('BNA+',                           NULL,  '00000010', 'billetera','🏦'),
        ('Banco Provincia Digital (BPBA)', NULL,  '00000020', 'billetera','🏦')
      ON DUPLICATE KEY UPDATE
        codigo_bcra = COALESCE(VALUES(codigo_bcra), codigo_bcra),
        cvu_prefix  = COALESCE(VALUES(cvu_prefix),  cvu_prefix),
        tipo        = VALUES(tipo),
        logo_emoji  = VALUES(logo_emoji);
    `).catch(e => console.warn('[DB] Seed bancos:', e.message));
    console.log('[DB] Tabla "bancos" poblada.');

    // 10. Tabla de Préstamos Normalizada
    await db.query(`
      CREATE TABLE IF NOT EXISTS prestamos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre_prestatario VARCHAR(255) NOT NULL,
        dni_cuit VARCHAR(50) NULL,
        monto DECIMAL(12,2) NOT NULL,
        fecha_prestamo DATE NOT NULL,
        tipo_prestamo VARCHAR(100) NOT NULL, -- 'Personal', 'Nacion', 'Otros PMO'
        banco_id INT NULL,
        tasa DECIMAL(5,2) NULL,
        cuotas_totales INT NULL,
        estado VARCHAR(50) DEFAULT 'pendiente', -- 'pendiente', 'pagado', 'activo'
        observaciones TEXT NULL,
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (banco_id) REFERENCES bancos(id) ON DELETE SET NULL
      ) ENGINE=InnoDB;
    `);
    console.log('[DB] Tabla "prestamos" verificada/creada.');

    // 11. Tabla de Cuotas / Pagos de Préstamos Bancarios / PMO
    await db.query(`
      CREATE TABLE IF NOT EXISTS prestamo_cuotas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        prestamo_id INT NOT NULL,
        nro_cuota INT NOT NULL,
        monto_cuota DECIMAL(12,2) NOT NULL,
        fecha_pago DATE NULL,
        estado VARCHAR(50) DEFAULT 'pendiente', -- 'pendiente', 'pagado'
        monto_seguro DECIMAL(12,2) DEFAULT 0.00,
        fecha_seguro DATE NULL,
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (prestamo_id) REFERENCES prestamos(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log('[DB] Tabla "prestamo_cuotas" verificada/creada.');

    // 12. Tabla de Pagos / Transacciones Financieras
    await db.query(`
      CREATE TABLE IF NOT EXISTS pagos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        chofer_id INT NULL, -- Hacemos chofer_id NULLABLE ya que préstamos/egresos bancarios no corresponden a choferes
        cuenta_id INT NULL,
        monto DECIMAL(12,2) NOT NULL,
        tipo VARCHAR(20) NOT NULL, -- 'ingreso', 'egreso', 'reintegro'
        concepto VARCHAR(50) NOT NULL, -- 'alquiler', 'multas', 'peajes', 'kiosco', etc.
        fecha DATE NOT NULL,
        medio_pago VARCHAR(50) NULL, -- 'MercadoPago', 'Efectivo', 'BBVA', etc.
        detalle TEXT NULL,
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chofer_id) REFERENCES choferes(id) ON DELETE CASCADE,
        FOREIGN KEY (cuenta_id) REFERENCES cuentas(id) ON DELETE SET NULL
      ) ENGINE=InnoDB;
    `);
    console.log('[DB] Tabla "pagos" verificada/creada.');

    // 11. Tabla de Jornadas (Flujo diario)
    await db.query(`
      CREATE TABLE IF NOT EXISTS jornadas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        chofer_id INT NOT NULL,
        vehiculo_id INT NOT NULL,
        fecha_inicio TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        fecha_fin TIMESTAMP NULL,
        km_inicio INT NULL,
        km_fin INT NULL,
        observaciones TEXT NULL,
        estado VARCHAR(50) DEFAULT 'activa',
        FOREIGN KEY (chofer_id) REFERENCES choferes(id) ON DELETE RESTRICT,
        FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB;
    `);
    console.log('[DB] Tabla "jornadas" verificada/creada.');

    // 12. Tabla de Historial VTV
    await db.query(`
      CREATE TABLE IF NOT EXISTS vehiculo_vtv (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vehiculo_id INT NOT NULL,
        vigencia_desde DATE NOT NULL,
        vigencia_hasta DATE NOT NULL,
        archivo_adjunto VARCHAR(255) NULL,
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log('[DB] Tabla "vehiculo_vtv" verificada/creada.');

    // 13. Tabla de Historial GNC
    await db.query(`
      CREATE TABLE IF NOT EXISTS vehiculo_gnc (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vehiculo_id INT NOT NULL,
        vigencia_desde DATE NOT NULL,
        vigencia_hasta DATE NOT NULL,
        archivo_adjunto VARCHAR(255) NULL,
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log('[DB] Tabla "vehiculo_gnc" verificada/creada.');

    // 14. Tabla de Historial Seguros
    await db.query(`
      CREATE TABLE IF NOT EXISTS vehiculo_seguros (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vehiculo_id INT NOT NULL,
        aseguradora_id INT NOT NULL,
        nro_poliza VARCHAR(100) NOT NULL,
        vigencia_desde DATE NOT NULL,
        vigencia_hasta DATE NOT NULL,
        archivo_adjunto VARCHAR(255) NULL,
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id) ON DELETE CASCADE,
        FOREIGN KEY (aseguradora_id) REFERENCES aseguradoras(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB;
    `);
    console.log('[DB] Tabla "vehiculo_seguros" verificada/creada.');

    // 15. Columnas nuevas en vehiculos (titular contacto + datos DNRPA)
    await db.query(`ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS titular_email VARCHAR(150) NULL`).catch(() => {});
    await db.query(`ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS titular_celular VARCHAR(50) NULL`).catch(() => {});
    await db.query(`ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS cedula_frente_url VARCHAR(255) NULL`).catch(() => {});
    await db.query(`ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS cedula_dorso_url VARCHAR(255) NULL`).catch(() => {});
    // Datos del titular extraídos de la cédula / DNRPA
    await db.query(`ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS titular_nombre VARCHAR(200) NULL`).catch(() => {});
    await db.query(`ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS titular_dni VARCHAR(30) NULL`).catch(() => {});
    await db.query(`ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS titular_cuit VARCHAR(20) NULL`).catch(() => {});
    await db.query(`ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS titular_domicilio VARCHAR(255) NULL`).catch(() => {});
    await db.query(`ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS titular_lat DECIMAL(10,7) NULL`).catch(() => {});
    await db.query(`ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS titular_lng DECIMAL(10,7) NULL`).catch(() => {});
    // Datos técnicos adicionales
    await db.query(`ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS tipo_vehiculo VARCHAR(100) NULL`).catch(() => {});
    await db.query(`ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS uso VARCHAR(50) NULL`).catch(() => {});

    // 16. Fotos del estado físico del vehículo (4 lados) — tabla normalizada ya existe (vehiculo_fotos)

    // 17. Contactos alternativos del titular
    await db.query(`
      CREATE TABLE IF NOT EXISTS vehiculo_contactos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vehiculo_id INT NOT NULL,
        nombre VARCHAR(150) NOT NULL,
        celular VARCHAR(50) NULL,
        email VARCHAR(150) NULL,
        FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log('[DB] Tabla "vehiculo_contactos" verificada/creada.');

    // 18. Columnas nuevas en vehiculo_gnc
    await db.query(`ALTER TABLE vehiculo_gnc ADD COLUMN IF NOT EXISTS numero_oblea VARCHAR(100) NULL`).catch(() => {});
    await db.query(`ALTER TABLE vehiculo_gnc ADD COLUMN IF NOT EXISTS regulador VARCHAR(150) NULL`).catch(() => {});

    // 18b. Cilindros GNC (hasta 4 por registro)
    for (let i = 1; i <= 4; i++) {
      await db.query(`ALTER TABLE vehiculo_gnc ADD COLUMN IF NOT EXISTS cil${i}_marca   VARCHAR(100) NULL`).catch(() => {});
      await db.query(`ALTER TABLE vehiculo_gnc ADD COLUMN IF NOT EXISTS cil${i}_serie   VARCHAR(100) NULL`).catch(() => {});
      await db.query(`ALTER TABLE vehiculo_gnc ADD COLUMN IF NOT EXISTS cil${i}_vto     DATE NULL`).catch(() => {});
    }

    // 19. Alertas de vencimiento
    await db.query(`
      CREATE TABLE IF NOT EXISTS alertas_vencimiento (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vehiculo_id INT NOT NULL,
        tipo ENUM('gnc','seguro','vtv') NOT NULL,
        referencia_id INT NOT NULL,
        mensaje TEXT,
        fecha_vencimiento DATE,
        leida TINYINT DEFAULT 0,
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log('[DB] Tabla "alertas_vencimiento" verificada/creada.');

    // 20. Tabla de Usuarios y Permisos
    await db.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(150) NOT NULL,
        email VARCHAR(150) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        rol ENUM('superadmin','admin','operador','solo_lectura') NOT NULL DEFAULT 'operador',
        activo TINYINT DEFAULT 1,
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS permisos_pantallas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        pantalla VARCHAR(50) NOT NULL,
        permitido TINYINT DEFAULT 1,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
        UNIQUE KEY uq_usuario_pantalla (usuario_id, pantalla)
      ) ENGINE=InnoDB;
    `);
    // Seed: superadmin oscarstasiulevicius@gmail.com / Luna&Sol
    const bcrypt = require('bcryptjs');
    const [adminCheck] = await db.query("SELECT id FROM usuarios WHERE email = 'oscarstasiulevicius@gmail.com'");
    if (!adminCheck.length) {
      const hash = await bcrypt.hash('Luna&Sol', 10);
      const [ar] = await db.query(
        "INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES ('Oscar Stasiulevicius', 'oscarstasiulevicius@gmail.com', ?, 'superadmin')",
        [hash]
      );
      const pantallas = ['dashboard','choferes','vehiculos','proveedores','services','multas','finanzas','usuarios'];
      if (ar.insertId) {
        const vals = pantallas.map(p => [ar.insertId, p, 1]);
        await db.query('INSERT INTO permisos_pantallas (usuario_id, pantalla, permitido) VALUES ?', [vals]);
      }
      console.log('[DB] Superadmin creado: oscarstasiulevicius@gmail.com');
    }
    // Columnas de auditoría en tablas principales
    const auditTables = ['choferes','vehiculos','proveedores','services','multas','pagos','vehiculo_gnc','vehiculo_seguros','productos','usuarios'];
    for (const t of auditTables) {
      await db.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS creado_por INT NULL`).catch(() => {});
      await db.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS modificado_por INT NULL`).catch(() => {});
      await db.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS creado_en DATETIME NULL`).catch(() => {});
      await db.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS modificado_en DATETIME NULL`).catch(() => {});
    }
    console.log('[DB] Tablas de usuarios y permisos verificadas/creadas.');

    // 21. Columnas de documentos en choferes
    await db.query(`ALTER TABLE choferes ADD COLUMN IF NOT EXISTS dni_frente_url VARCHAR(255) NULL`).catch(() => {});
    await db.query(`ALTER TABLE choferes ADD COLUMN IF NOT EXISTS dni_dorso_url VARCHAR(255) NULL`).catch(() => {});
    await db.query(`ALTER TABLE choferes ADD COLUMN IF NOT EXISTS registro_frente_url VARCHAR(255) NULL`).catch(() => {});
    await db.query(`ALTER TABLE choferes ADD COLUMN IF NOT EXISTS registro_dorso_url VARCHAR(255) NULL`).catch(() => {});
    await db.query(`ALTER TABLE choferes ADD COLUMN IF NOT EXISTS registro_categoria VARCHAR(50) NULL`).catch(() => {});
    await db.query(`ALTER TABLE choferes ADD COLUMN IF NOT EXISTS registro_vencimiento DATE NULL`).catch(() => {});
    await db.query(`ALTER TABLE choferes ADD COLUMN IF NOT EXISTS calif1_url VARCHAR(255) NULL`).catch(() => {});
    await db.query(`ALTER TABLE choferes ADD COLUMN IF NOT EXISTS calif2_url VARCHAR(255) NULL`).catch(() => {});

    // 22. Columnas GPS y nuevos campos en proveedores
    await db.query(`ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS email VARCHAR(150) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS condicion_fiscal_id INT NULL`).catch(()=>{});
    await db.query(`ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS lat DECIMAL(10,7) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS lng DECIMAL(10,7) NULL`).catch(()=>{});
    // GPS en choferes
    await db.query(`ALTER TABLE choferes ADD COLUMN IF NOT EXISTS lat DECIMAL(10,7) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE choferes ADD COLUMN IF NOT EXISTS lng DECIMAL(10,7) NULL`).catch(()=>{});
    // Telegram
    await db.query(`ALTER TABLE choferes ADD COLUMN IF NOT EXISTS telegram_chat_id VARCHAR(50) NULL`).catch(()=>{});
    // Sucursales de proveedores
    await db.query(`
      CREATE TABLE IF NOT EXISTS proveedor_sucursales (
        id INT AUTO_INCREMENT PRIMARY KEY,
        proveedor_id INT NOT NULL,
        nombre VARCHAR(150) NOT NULL,
        domicilio VARCHAR(255) NULL,
        lat DECIMAL(10,7) NULL,
        lng DECIMAL(10,7) NULL,
        telefono VARCHAR(50) NULL,
        email VARCHAR(150) NULL,
        FOREIGN KEY (proveedor_id) REFERENCES proveedores(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    // Services: fotos y campos extra
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS notas TEXT NULL`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS tipo VARCHAR(150) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS descripcion TEXT NULL`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS costo DECIMAL(12,2) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS kilometraje INT NULL`).catch(()=>{});
    await db.query(`
      CREATE TABLE IF NOT EXISTS service_fotos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        service_id INT NOT NULL,
        url VARCHAR(255) NOT NULL,
        fecha_subida TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    // 23. Multas: nuevas columnas para CRUD completo + archivos
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS municipalidad_id INT NULL`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS numero_acta VARCHAR(80) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS lugar VARCHAR(200) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS puntos INT NULL`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS fecha_vencimiento DATE NULL`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS url_consulta VARCHAR(500) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS notas TEXT NULL`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS articulo_infringido VARCHAR(200) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS hora_infraccion TIME NULL`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS nombre_infractor VARCHAR(200) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS dni_infractor VARCHAR(20) NULL`).catch(()=>{});
    // 24. Multas: columnas de auditoría procesal
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS fecha_emision_acta DATE NULL`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS fecha_notificacion DATE NULL`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS medio_notificacion VARCHAR(100) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS codigo_seguimiento_postal VARCHAR(100) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE multas ADD COLUMN IF NOT EXISTS constancia_recepcion TINYINT(1) DEFAULT 0`).catch(()=>{});
    await db.query(`
      CREATE TABLE IF NOT EXISTS multa_adjuntos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        multa_id INT NOT NULL,
        tipo ENUM('imagen','pdf','video','link') NOT NULL DEFAULT 'imagen',
        url VARCHAR(500) NOT NULL,
        nombre_original VARCHAR(255) NULL,
        fecha_subida TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (multa_id) REFERENCES multas(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);
    // 24. Municipalidades
    await db.query(`
      CREATE TABLE IF NOT EXISTS municipalidades (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(150) NOT NULL,
        jurisdiccion ENUM('CABA','PBA','NACIONAL','OTRO') NOT NULL DEFAULT 'OTRO',
        provincia VARCHAR(100) NULL,
        url_consulta VARCHAR(500) NULL,
        url_pago VARCHAR(500) NULL,
        email_contacto VARCHAR(150) NULL,
        telefono VARCHAR(80) NULL,
        notas TEXT NULL,
        activa TINYINT(1) NOT NULL DEFAULT 1,
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);
    // Municipalidades: columna url_patron para búsqueda automática por patente
    await db.query(`ALTER TABLE municipalidades ADD COLUMN IF NOT EXISTS url_patron VARCHAR(500) NULL`).catch(()=>{});

    // Seed municipalidades conocidas (solo si están vacías o no existen aún)
    const knownMunis = [
      ['Avellaneda',      'PBA',      'https://multas.mda.gob.ar/', null, 'Buenos Aires'],
      ['CABA',            'CABA',     'https://buenosaires.gob.ar/gcaba_historico/tramites/consulta-de-infracciones', null, 'Ciudad Autónoma de Buenos Aires'],
      ['Bs As (Prov.)',   'PBA',      'https://infraccionesba.gba.gob.ar/consulta-infraccion', null, 'Buenos Aires'],
      ['Lomas de Zamora', 'PBA',      'https://webextra.lomasdezamora.gov.ar/infracciones/ConsultaFaltasNuevoMP.aspx', null, 'Buenos Aires'],
      ['Lanús',           'PBA',      'https://consulta-web.infratrack.com.ar/consultas.php?municipio=lanus', null, 'Buenos Aires'],
      ['Alte Brown',      'PBA',      'https://a.brown.gob.ar/transito/consultar-multa', null, 'Buenos Aires'],
    ];
    for (const [nombre, jurisdiccion, url_consulta, url_patron, provincia] of knownMunis) {
      await db.query(
        `INSERT INTO municipalidades (nombre, jurisdiccion, url_consulta, url_patron, provincia)
         SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM municipalidades WHERE nombre=?)`,
        [nombre, jurisdiccion, url_consulta, url_patron, provincia, nombre]
      ).catch(()=>{});
    }

    // Factura en services
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS factura_numero VARCHAR(80) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS factura_fecha DATE NULL`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS factura_url VARCHAR(500) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS factura_proveedor VARCHAR(150) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS factura_cuit VARCHAR(50) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS factura_tipo_auth ENUM('CAE','CAEA','CAI') NULL`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS factura_subtotal DECIMAL(12,2) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS factura_iva DECIMAL(12,2) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS factura_total DECIMAL(12,2) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS factura_items TEXT NULL`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS factura_receptor VARCHAR(255) NULL`).catch(()=>{});
    // Nuevos campos de factura AFIP + auditoría
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS factura_tipo VARCHAR(50) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS factura_proveedor_id INT NULL`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS factura_cae VARCHAR(20) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS factura_cae_vto DATE NULL`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS factura_cargado_por INT NULL COMMENT 'usuario_id que cargó la factura'`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS factura_cargado_at DATETIME NULL COMMENT 'fecha/hora de carga de la factura'`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS cargado_por INT NULL COMMENT 'usuario_id que creó el service'`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS modificado_por INT NULL COMMENT 'usuario_id que modificó por última vez'`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS modificado_at DATETIME NULL`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS km_intervalo INT NULL`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS km_proximo INT NULL`).catch(()=>{});
    await db.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS diagnostico_json JSON NULL COMMENT 'Certificado YPF: checklist, productos, observaciones'`).catch(()=>{});
    // ── VTV: nuevas columnas para AI/OCR ──────────────────────────
    await db.query(`ALTER TABLE vehiculo_vtv ADD COLUMN IF NOT EXISTS resultado ENUM('apto','condicional','rechazado') NULL`).catch(()=>{});
    await db.query(`ALTER TABLE vehiculo_vtv ADD COLUMN IF NOT EXISTS patente_vtv VARCHAR(20) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE vehiculo_vtv ADD COLUMN IF NOT EXISTS fecha_inspeccion DATE NULL`).catch(()=>{});
    await db.query(`ALTER TABLE vehiculo_vtv ADD COLUMN IF NOT EXISTS notas TEXT NULL`).catch(()=>{});
    await db.query(`ALTER TABLE vehiculo_vtv ADD COLUMN IF NOT EXISTS nro_inspeccion VARCHAR(20) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE vehiculo_vtv ADD COLUMN IF NOT EXISTS nro_oblea VARCHAR(20) NULL`).catch(()=>{});

    // ── Usuarios: campos extra ────────────────────────────────────
    await db.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS domicilio VARCHAR(255) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS lat DECIMAL(10,7) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS lng DECIMAL(10,7) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS fecha_nacimiento DATE NULL`).catch(()=>{});
    await db.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS celular VARCHAR(50) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telegram_chat_id VARCHAR(50) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS dni_frente_url VARCHAR(500) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS dni_dorso_url VARCHAR(500) NULL`).catch(()=>{});

    // ── Productos / Stock ─────────────────────────────────────────
    await db.query(`
      CREATE TABLE IF NOT EXISTS productos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(150) NOT NULL,
        descripcion TEXT NULL,
        precio_venta DECIMAL(10,2) NULL,
        foto_url VARCHAR(500) NULL,
        codigo_barras VARCHAR(100) NULL,
        stock_central INT NOT NULL DEFAULT 0,
        activo TINYINT(1) NOT NULL DEFAULT 1,
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS stock_entregas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        chofer_id INT NOT NULL,
        vehiculo_id INT NULL,
        fecha_entrega DATE NOT NULL,
        notas TEXT NULL,
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chofer_id) REFERENCES choferes(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB;
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS stock_entrega_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        entrega_id INT NOT NULL,
        producto_id INT NOT NULL,
        cantidad_entregada INT NOT NULL DEFAULT 0,
        cantidad_remanente INT NULL,
        cantidad_vendida INT GENERATED ALWAYS AS (cantidad_entregada - COALESCE(cantidad_remanente, 0)) VIRTUAL,
        FOREIGN KEY (entrega_id) REFERENCES stock_entregas(id) ON DELETE CASCADE,
        FOREIGN KEY (producto_id) REFERENCES productos(id)
      ) ENGINE=InnoDB;
    `);

    // ── Pagos: fecha → DATETIME para capturar hora de transferencia + columnas extra
    await db.query(`ALTER TABLE pagos MODIFY COLUMN fecha DATETIME NOT NULL`).catch(()=>{});
    {
      // MariaDB no soporta ADD COLUMN IF NOT EXISTS en versiones anteriores a 10.3.3
      // Usamos information_schema para agregar solo las columnas que faltan
      const addIfMissing = async (col, def) => {
        const [[r]] = await db.query(`SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pagos' AND COLUMN_NAME=?`, [col]);
        if (!r.c) { await db.query(`ALTER TABLE pagos ADD COLUMN ${col} ${def}`); console.log(`[DB] pagos: columna '${col}' agregada`); }
      };
      await addIfMissing('comprobante_url',        'VARCHAR(500) NULL');
      await addIfMissing('alias_destino',           'VARCHAR(100) NULL');
      await addIfMissing('nro_transaccion',         'VARCHAR(50)  NULL');
      await addIfMissing('codigo_identificacion',   'VARCHAR(100) NULL');
      await addIfMissing('origen_nombre',           'VARCHAR(200) NULL');
      await addIfMissing('origen_cuil',             'VARCHAR(30)  NULL');
      await addIfMissing('origen_cbu',              'VARCHAR(60)  NULL');
      await addIfMissing('origen_alias',            'VARCHAR(100) NULL');
      await addIfMissing('origen_banco',            'VARCHAR(100) NULL');
      await addIfMissing('destino_nombre',          'VARCHAR(200) NULL');
      await addIfMissing('destino_cuil',            'VARCHAR(30)  NULL');
      await addIfMissing('destino_cbu',             'VARCHAR(60)  NULL');
      await addIfMissing('destino_alias',           'VARCHAR(100) NULL');
      await addIfMissing('destino_banco',           'VARCHAR(100) NULL');
      await addIfMissing('factura_url',             'VARCHAR(500) NULL');
      await addIfMissing('factura_ref',             'VARCHAR(100) NULL');
    }

    // ── Auditoría de operaciones ─────────────────────────────────────────────
    await db.query(`
      CREATE TABLE IF NOT EXISTS auditoria (
        id          BIGINT AUTO_INCREMENT PRIMARY KEY,
        usuario_id  INT NULL,
        usuario_nombre VARCHAR(150) NULL,
        modulo      VARCHAR(50) NOT NULL,
        accion      VARCHAR(20) NOT NULL COMMENT 'crear|editar|eliminar|desactivar|activar|ver',
        entidad_id  INT NULL,
        descripcion VARCHAR(500) NULL,
        ip          VARCHAR(45) NULL,
        fecha       DATETIME NOT NULL DEFAULT NOW()
      ) ENGINE=InnoDB;
    `).catch(()=>{});

    // ── Permiso eliminar en permisos_pantallas ────────────────────────────────
    await db.query(`ALTER TABLE permisos_pantallas ADD COLUMN IF NOT EXISTS puede_eliminar TINYINT DEFAULT 0`).catch(()=>{});

    // ── Código postal ─────────────────────────────────────────────────────────
    await db.query(`ALTER TABLE choferes     ADD COLUMN IF NOT EXISTS codigo_postal VARCHAR(20) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE usuarios     ADD COLUMN IF NOT EXISTS codigo_postal VARCHAR(20) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE aseguradoras ADD COLUMN IF NOT EXISTS codigo_postal VARCHAR(20) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE proveedores  ADD COLUMN IF NOT EXISTS codigo_postal VARCHAR(20) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE vehiculos    ADD COLUMN IF NOT EXISTS titular_codigo_postal VARCHAR(20) NULL`).catch(()=>{});

    // ── Cuentas: ampliar columnas para CRUD completo
    await db.query(`ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS nombre    VARCHAR(100) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS apellido  VARCHAR(100) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS dni       VARCHAR(20)  NULL`).catch(()=>{});
    await db.query(`ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS cuil      VARCHAR(30)  NULL`).catch(()=>{});
    await db.query(`ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS cbu_cvu   VARCHAR(60)  NULL`).catch(()=>{});
    await db.query(`ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS banco_id  INT NULL`).catch(()=>{});

    // ── Pagos: columnas de transferencia (ya manejadas arriba con addIfMissing)

    // ── Credenciales de IA (proveedores configurables) ─────────────────────────
    await db.query(`
      CREATE TABLE IF NOT EXISTS credenciales_ia (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        nombre       VARCHAR(100) NOT NULL,
        proveedor    VARCHAR(50)  NOT NULL DEFAULT 'anthropic',
        api_key      TEXT         NOT NULL,
        modelo       VARCHAR(100) NOT NULL DEFAULT 'claude-sonnet-4-6',
        activa       TINYINT      NOT NULL DEFAULT 0,
        precio_input  DECIMAL(10,6) NOT NULL DEFAULT 3.000000,
        precio_output DECIMAL(10,6) NOT NULL DEFAULT 15.000000,
        notas        VARCHAR(300) NULL,
        created_at   DATETIME     NOT NULL DEFAULT NOW(),
        updated_at   DATETIME     NOT NULL DEFAULT NOW() ON UPDATE NOW()
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `).catch(()=>{});

    // ── Log de uso de IA (tokens por tarea) ─────────────────────────────────────
    await db.query(`
      CREATE TABLE IF NOT EXISTS ia_log (
        id              BIGINT AUTO_INCREMENT PRIMARY KEY,
        credencial_id   INT          NULL,
        tarea           VARCHAR(100) NOT NULL,
        modelo          VARCHAR(100) NULL,
        input_tokens    INT          NOT NULL DEFAULT 0,
        output_tokens   INT          NOT NULL DEFAULT 0,
        costo_usd       DECIMAL(10,6) NOT NULL DEFAULT 0,
        usuario_id      INT          NULL,
        usuario_nombre  VARCHAR(150) NULL,
        modulo          VARCHAR(80)  NULL,
        entidad_id      INT          NULL,
        fecha           DATETIME     NOT NULL DEFAULT NOW()
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `).catch(()=>{});
    await db.query(`ALTER TABLE ia_log ADD COLUMN IF NOT EXISTS modulo VARCHAR(80) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE ia_log ADD COLUMN IF NOT EXISTS entidad_id INT NULL`).catch(()=>{});

    // ── Conceptos de pago (imputación por concepto para ingresos/cobranzas) ───
    await db.query(`
      CREATE TABLE IF NOT EXISTS pago_conceptos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        pago_id INT NOT NULL,
        concepto VARCHAR(50) NOT NULL,
        monto DECIMAL(12,2) NOT NULL DEFAULT 0,
        FOREIGN KEY (pago_id) REFERENCES pagos(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `).catch(()=>{});

    await db.query(`UPDATE pago_conceptos SET concepto='multas' WHERE concepto='deuda_general'`).catch(()=>{});

    // ── Turnos ────────────────────────────────────────────────────────────────
    await db.query(`
      CREATE TABLE IF NOT EXISTS turnos (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        fecha_inicio  DATETIME      NOT NULL,
        fecha_fin     DATETIME      NULL,
        horas         DECIMAL(7,4)  NULL,
        km_inicio     DECIMAL(10,1) NULL,
        km_fin        DECIMAL(10,1) NULL,
        recorrido     DECIMAL(10,1) NULL,
        vehiculo_id   INT           NULL,
        chofer_id     INT           NOT NULL,
        modalidad     DECIMAL(14,2) NULL,
        gnc           DECIMAL(12,2) NOT NULL DEFAULT 0,
        viajes        DECIMAL(12,2) NOT NULL DEFAULT 0,
        peajes        DECIMAL(12,2) NOT NULL DEFAULT 0,
        importe       DECIMAL(12,2) NULL,
        notas         TEXT          NULL,
        created_by    INT           NULL,
        created_at    DATETIME      NOT NULL DEFAULT NOW(),
        updated_by    INT           NULL,
        updated_at    DATETIME      NULL ON UPDATE NOW(),
        FOREIGN KEY (chofer_id)   REFERENCES choferes(id),
        FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `).catch(()=>{});

    // (bancos seed ya está arriba, este bloque fue consolidado)

    // ── Seed cuentas propias ──────────────────────────────────────────────────
    await db.query(`
      INSERT INTO cuentas (alias, nombre, apellido, dni, cuil, cbu_cvu) VALUES
        ('osconsultor.mp',    'Oscar',    'Stasiulevicius', '23816627', '20-23816627-7', '0000003100073404688558'),
        ('SSTASI.COCOS',      'Sebastian','Stasiulevicius', '41558670', '20-41558670-2', NULL),
        ('Seba.stasiu.buepp', 'Sebas',   'Stasiulevicius', '41558670', '20-41558670-2', NULL)
      ON DUPLICATE KEY UPDATE
        nombre   = VALUES(nombre),
        apellido = VALUES(apellido),
        dni      = VALUES(dni),
        cuil     = VALUES(cuil),
        cbu_cvu  = COALESCE(VALUES(cbu_cvu), cbu_cvu);
    `).catch(e => console.warn('[DB] Seed cuentas:', e.message));

    // ── Tabla de Personas (Propietarios de vehículos / titulares de cuentas) ──
    await db.query(`
      CREATE TABLE IF NOT EXISTS personas (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        nombre           VARCHAR(100) NOT NULL,
        apellido         VARCHAR(100) NOT NULL,
        dni              VARCHAR(20)  NULL,
        cuil             VARCHAR(30)  NULL,
        email            VARCHAR(150) NULL,
        celular          VARCHAR(50)  NULL,
        domicilio        VARCHAR(255) NULL,
        codigo_postal    VARCHAR(20)  NULL,
        lat              DECIMAL(10,7) NULL,
        lng              DECIMAL(10,7) NULL,
        activo           TINYINT DEFAULT 1,
        fecha_registro   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_persona_dni (dni)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `).catch(()=>{});

    // Auditoría en personas
    await db.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS created_by INT NULL`).catch(()=>{});
    await db.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS updated_by INT NULL`).catch(()=>{});
    await db.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NULL ON UPDATE CURRENT_TIMESTAMP`).catch(()=>{});
    await db.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS foto_url VARCHAR(500) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS entre_calles VARCHAR(255) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS localidad VARCHAR(150) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS referencia VARCHAR(255) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS telegram_chat_id VARCHAR(50) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS entre_calles VARCHAR(255) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE choferes ADD COLUMN IF NOT EXISTS entre_calles VARCHAR(255) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE aseguradoras ADD COLUMN IF NOT EXISTS entre_calles VARCHAR(255) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE sucursales ADD COLUMN IF NOT EXISTS entre_calles VARCHAR(255) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE proveedor_sucursales ADD COLUMN IF NOT EXISTS entre_calles VARCHAR(255) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS dni_frente_url VARCHAR(500) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS dni_dorso_url  VARCHAR(500) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE personas ADD CONSTRAINT fk_personas_created_by FOREIGN KEY (created_by) REFERENCES usuarios(id) ON DELETE SET NULL`).catch(()=>{});
    await db.query(`ALTER TABLE personas ADD CONSTRAINT fk_personas_updated_by FOREIGN KEY (updated_by) REFERENCES usuarios(id) ON DELETE SET NULL`).catch(()=>{});

    // Año de fabricación del vehículo
    await db.query(`ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS \`año\` SMALLINT NULL`).catch(()=>{});

    // FK persona_id en vehiculos y cuentas
    await db.query(`ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS persona_id INT NULL`).catch(()=>{});
    await db.query(`ALTER TABLE cuentas   ADD COLUMN IF NOT EXISTS persona_id INT NULL`).catch(()=>{});

    // Agregar FKs si no existen (MySQL ignora si ya existen con nombre)
    await db.query(`
      ALTER TABLE vehiculos
        ADD CONSTRAINT fk_vehiculos_persona
        FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE SET NULL
    `).catch(()=>{});
    await db.query(`
      ALTER TABLE cuentas
        ADD CONSTRAINT fk_cuentas_persona
        FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE SET NULL
    `).catch(()=>{});

    // ── Tabla de peajes ──────────────────────────────────────────────────────
    await db.query(`
      CREATE TABLE IF NOT EXISTS peajes (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        autopista    VARCHAR(200) NOT NULL,
        patente      VARCHAR(20)  NOT NULL,
        fecha_hora   DATETIME     NOT NULL,
        importe      DECIMAL(12,2) NOT NULL,
        vehiculo_id  INT NULL,
        cargado_por  INT NULL,
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_peaje (autopista, patente, fecha_hora),
        FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id) ON DELETE SET NULL,
        FOREIGN KEY (cargado_por) REFERENCES usuarios(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `).catch(()=>{});

    await db.query(`ALTER TABLE peajes ADD COLUMN IF NOT EXISTS cargado_por INT NULL`).catch(()=>{});
    await db.query(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS aceite_ok          TINYINT(1)   NULL DEFAULT NULL`).catch(()=>{});
    await db.query(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS foto_novedad        VARCHAR(500) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS foto_km_inicio      VARCHAR(500) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS foto_km_fin         VARCHAR(500) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS combustible_inicio  VARCHAR(10)  NULL`).catch(()=>{});
    await db.query(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS combustible_fin     VARCHAR(10)  NULL`).catch(()=>{});
    await db.query(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS aceite_nivel        VARCHAR(20)  NULL`).catch(()=>{});
    await db.query(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS foto_aceite         VARCHAR(500) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE peajes ADD COLUMN IF NOT EXISTS barrera VARCHAR(200) NOT NULL DEFAULT ''`).catch(()=>{});
    await db.query(`ALTER TABLE peajes MODIFY COLUMN patente VARCHAR(20) NOT NULL DEFAULT ''`).catch(()=>{});
    // Reemplazar clave única para incluir barrera y admitir patente vacía
    await db.query(`ALTER TABLE peajes DROP INDEX uk_peaje`).catch(()=>{});
    await db.query(`ALTER TABLE peajes ADD UNIQUE KEY uk_peaje (autopista, barrera, patente, fecha_hora)`).catch(()=>{});

    // ── Préstamos: ampliar cabecera + nueva tabla de cuotas ──────────────────
    await db.query(`ALTER TABLE prestamos ADD COLUMN IF NOT EXISTS cuenta_id         INT          NULL`).catch(()=>{});
    await db.query(`ALTER TABLE prestamos ADD COLUMN IF NOT EXISTS vehiculo_id       INT          NULL`).catch(()=>{});
    await db.query(`ALTER TABLE prestamos ADD COLUMN IF NOT EXISTS capital           DECIMAL(14,2) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE prestamos ADD COLUMN IF NOT EXISTS tipo_amortizacion VARCHAR(50)  NULL`).catch(()=>{});
    await db.query(`ALTER TABLE prestamos ADD COLUMN IF NOT EXISTS plazo_meses       INT          NULL`).catch(()=>{});
    await db.query(`ALTER TABLE prestamos ADD COLUMN IF NOT EXISTS fecha_inicio      DATE         NULL`).catch(()=>{});
    await db.query(`ALTER TABLE prestamos ADD COLUMN IF NOT EXISTS descripcion       TEXT         NULL`).catch(()=>{});
    await db.query(`
      ALTER TABLE prestamos
        ADD CONSTRAINT fk_prestamos_cuenta   FOREIGN KEY (cuenta_id)   REFERENCES cuentas(id)   ON DELETE SET NULL
    `).catch(()=>{});
    await db.query(`
      ALTER TABLE prestamos
        ADD CONSTRAINT fk_prestamos_vehiculo FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id) ON DELETE SET NULL
    `).catch(()=>{});

    // Auditoría en préstamos
    await db.query(`ALTER TABLE prestamos ADD COLUMN IF NOT EXISTS created_by INT NULL`).catch(()=>{});
    await db.query(`ALTER TABLE prestamos ADD COLUMN IF NOT EXISTS updated_by INT NULL`).catch(()=>{});
    await db.query(`ALTER TABLE prestamos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NULL ON UPDATE CURRENT_TIMESTAMP`).catch(()=>{});
    await db.query(`ALTER TABLE prestamos ADD CONSTRAINT fk_prestamos_created_by FOREIGN KEY (created_by) REFERENCES usuarios(id) ON DELETE SET NULL`).catch(()=>{});
    await db.query(`ALTER TABLE prestamos ADD CONSTRAINT fk_prestamos_updated_by FOREIGN KEY (updated_by) REFERENCES usuarios(id) ON DELETE SET NULL`).catch(()=>{});

    // Nueva tabla limpia de cuotas (sustituye a prestamo_cuotas)
    await db.query(`
      CREATE TABLE IF NOT EXISTS prestamos_cuotas (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        prestamo_id  INT           NOT NULL,
        nro_cuota    INT           NOT NULL,
        fecha        DATE          NOT NULL,
        importe      DECIMAL(14,2) NOT NULL,
        pagada       TINYINT       DEFAULT 0,
        fecha_pago   DATE          NULL,
        created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (prestamo_id) REFERENCES prestamos(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `).catch(()=>{});

    // ── Tabla de configuración global (credenciales, API keys) ───────────────
    await db.query(`
      CREATE TABLE IF NOT EXISTS configuracion (
        clave   VARCHAR(100) NOT NULL PRIMARY KEY,
        valor   TEXT         NULL,
        descripcion VARCHAR(255) NULL,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `).catch(()=>{});
    // Seed claves conocidas (sin valor por defecto)
    await db.query(`
      INSERT IGNORE INTO configuracion (clave, descripcion) VALUES
        ('ANTHROPIC_API_KEY', 'Clave API de Anthropic (Claude IA)'),
        ('R2_ACCOUNT_ID',     'Cloudflare R2 Account ID'),
        ('R2_ACCESS_KEY_ID',  'Cloudflare R2 Access Key ID'),
        ('R2_SECRET_ACCESS_KEY', 'Cloudflare R2 Secret Access Key'),
        ('R2_BUCKET_NAME',    'Cloudflare R2 Bucket Name'),
        ('R2_PUBLIC_URL',     'URL pública del bucket R2')
    `).catch(()=>{});

    await db.query(`ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS alias   VARCHAR(100) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS cbu_cvu VARCHAR(30)  NULL`).catch(()=>{});

    // Tarjetas de crédito/débito de propietarios
    await db.query(`
      CREATE TABLE IF NOT EXISTS tarjetas (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        persona_id   INT          NULL,
        banco_nombre VARCHAR(100) NULL,
        marca        VARCHAR(50)  NOT NULL,
        ultimos_4    VARCHAR(4)   NULL,
        activo       TINYINT      DEFAULT 1,
        created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE SET NULL
      ) ENGINE=InnoDB
    `).catch(()=>{});

    await db.query(`ALTER TABLE tarjetas ADD COLUMN IF NOT EXISTS banco_id INT NULL`).catch(()=>{});
    await db.query(`ALTER TABLE tarjetas ADD COLUMN IF NOT EXISTS banco_nombre VARCHAR(100) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE tarjetas ADD COLUMN IF NOT EXISTS nro_tarjeta_enc TEXT NULL`).catch(()=>{});

    // Pagos de services (multi-pago por service)
    await db.query(`
      CREATE TABLE IF NOT EXISTS service_pagos (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        service_id  INT           NOT NULL,
        medio       VARCHAR(50)   NOT NULL,
        monto       DECIMAL(14,2) NOT NULL,
        cuenta_id   INT           NULL,
        tarjeta_id  INT           NULL,
        cuotas      INT           DEFAULT 1,
        notas       VARCHAR(255)  NULL,
        created_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (service_id)  REFERENCES services(id)  ON DELETE CASCADE,
        FOREIGN KEY (cuenta_id)   REFERENCES cuentas(id)   ON DELETE SET NULL,
        FOREIGN KEY (tarjeta_id)  REFERENCES tarjetas(id)  ON DELETE SET NULL
      ) ENGINE=InnoDB
    `).catch(()=>{});

    // ── AFIP — contribuyentes (multi-CUIT) ───────────────────────────────────
    await db.query(`
      CREATE TABLE IF NOT EXISTS afip_contribuyentes (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        cuit         BIGINT       NOT NULL UNIQUE,
        nombre       VARCHAR(200) NOT NULL,
        punto_venta  SMALLINT     NOT NULL DEFAULT 1,
        production   TINYINT      NOT NULL DEFAULT 0,
        cert_pem     TEXT         NULL,
        key_pem      TEXT         NULL,
        cert_vence   DATE         NULL,
        activo       TINYINT      NOT NULL DEFAULT 1,
        notas        TEXT         NULL,
        wscdc_url    VARCHAR(500) NULL,
        created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `).catch(()=>{});
    await db.query(`ALTER TABLE afip_contribuyentes ADD COLUMN IF NOT EXISTS wscdc_url VARCHAR(500) NULL`).catch(()=>{});
    await db.query(`ALTER TABLE afip_contribuyentes ADD COLUMN IF NOT EXISTS concepto_base VARCHAR(200) NULL`).catch(()=>{});

    // ── ARCA / AFIP — comprobantes sincronizados ──────────────────────────────
    await db.query(`
      CREATE TABLE IF NOT EXISTS afip_comprobantes (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        direccion        ENUM('emitido','recibido') NOT NULL,
        codigo_tipo      SMALLINT     NOT NULL,
        desc_tipo        VARCHAR(60)  NULL,
        pto_venta        SMALLINT     NOT NULL,
        nro_comprobante  INT          NOT NULL,
        fecha_cbte       DATE         NOT NULL,
        fecha_vto_pago   DATE         NULL,
        cuit_emisor      BIGINT       NOT NULL,
        razon_social     VARCHAR(200) NULL,
        cuit_receptor    BIGINT       NULL,
        importe_total    DECIMAL(14,2) DEFAULT 0,
        importe_neto     DECIMAL(14,2) DEFAULT 0,
        importe_iva      DECIMAL(14,2) DEFAULT 0,
        moneda           VARCHAR(4)   DEFAULT 'PES',
        cae              VARCHAR(30)  NULL,
        cae_vto          DATE         NULL,
        estado           VARCHAR(30)  DEFAULT 'A',
        raw_json         JSON         NULL,
        synced_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_cbte (direccion, cuit_emisor, codigo_tipo, pto_venta, nro_comprobante)
      ) ENGINE=InnoDB
    `).catch(()=>{});

    await db.query(`ALTER TABLE afip_comprobantes ADD COLUMN IF NOT EXISTS pdf_url VARCHAR(500) NULL`).catch(()=>{});

    await db.query(`
      CREATE TABLE IF NOT EXISTS afip_sync_log (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        direccion   ENUM('emitido','recibido') NOT NULL,
        fecha_desde DATE NOT NULL,
        fecha_hasta DATE NOT NULL,
        total_nuevos INT DEFAULT 0,
        synced_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        error       TEXT NULL
      ) ENGINE=InnoDB
    `).catch(()=>{});

    await db.query(`
      CREATE TABLE IF NOT EXISTS afip_tokens (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        cuit        BIGINT NOT NULL,
        service     VARCHAR(50) NOT NULL,
        environment ENUM('prod','homo') NOT NULL DEFAULT 'homo',
        token       LONGTEXT NOT NULL,
        sign        TEXT NOT NULL,
        expires_at  DATETIME NOT NULL,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_ta (cuit, service, environment)
      ) ENGINE=InnoDB
    `).catch(()=>{});

    console.log('[DB] Inicialización de base de datos completa con esquema ampliado.');
  } catch (error) {
    console.error('[DB] Error durante la inicialización de las tablas:', error.message);
    process.exit(1);
  }
}

// Ejecutar inicialización si este archivo se corre directamente
if (require.main === module) {
  initializeDatabase().then(async () => {
    if (pool) {
      await pool.end();
      console.log('[DB] Pool de conexiones cerrado con éxito.');
    }
    process.exit(0);
  }).catch((err) => {
    console.error('[DB] Fallo en la inicialización:', err);
    process.exit(1);
  });
}

module.exports = {
  getPool,
  initializeDatabase
};
