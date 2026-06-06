# Sistema de Logística para Control de Flota

Este proyecto es un sistema de logística diseñado para el control de flota de vehículos, integrando mensajería automática a través de WhatsApp y almacenamiento de evidencias (fotos) en la nube.

## 🚀 Tecnologías Principales

- **Entorno de Ejecución:** Node.js
- **Base de Datos:** MySQL
  - **Host:** `127.0.0.1`
  - **Puerto:** `3306`
  - **Usuario:** `root`
  - **Contraseña:** `""` (vacía)
  - **Nombre de Base de Datos:** `flota` (flota.db)
- **Integración de Mensajería:** `whatsapp-web.js` (usado para escuchar grupos y chats privados)
- **Almacenamiento de Fotos:** Cloudflare R2 (compatible con la API de AWS S3)

## 📁 Estructura del Proyecto Recomendada

```text
├── src/
│   ├── config/          # Configuraciones (DB, WhatsApp, Cloudflare R2)
│   ├── handlers/        # Controladores de eventos de WhatsApp (mensajes, grupos)
│   ├── services/        # Lógica de negocio (gestión de flota, almacenamiento, reportes)
│   ├── utils/           # Utilidades y funciones auxiliares
│   └── index.js         # Punto de entrada de la aplicación
├── .cursorrules         # Reglas del espacio de trabajo para asistentes de IA
├── .clinerules          # Reglas adicionales para asistentes de IA
├── .env.example         # Ejemplo de variables de entorno
└── package.json         # Dependencias del proyecto
```

## ⚙️ Configuración Inicial

1. **Variables de Entorno:**
   Crea un archivo `.env` en la raíz del proyecto basándote en el archivo `.env.example`:
   ```env
   DB_HOST=127.0.0.1
   DB_PORT=3306
   DB_USER=root
   DB_PASSWORD=
   DB_NAME=flota

   R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
   R2_ACCESS_KEY_ID=tu_access_key
   R2_SECRET_ACCESS_KEY=tu_secret_key
   R2_BUCKET_NAME=flota-fotos
   ```

2. **Instalación de Dependencias:**
   Una vez inicializado el proyecto, se requerirán paquetes como:
   - `mysql2` para conectarse a la base de datos MySQL.
   - `whatsapp-web.js` junto con `qrcode-terminal` para el bot de WhatsApp.
   - `@aws-sdk/client-s3` para la integración con Cloudflare R2.
   - `dotenv` para la carga de variables de entorno.
