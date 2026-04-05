const express = require('express');
const crypto = require('crypto');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
require('dotenv').config();

const app = express();
app.use(express.json());

// Render suele usar el puerto 10000 por defecto
const PORT = process.env.PORT || 10000;

// Configuración de la llave privada de Meta (RSA) para desencriptar
const PRIVATE_KEY = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') : null;

// --- CONFIGURACIÓN DE GOOGLE SHEETS ---
// IMPORTANTE: El archivo en GitHub debe llamarse google-key.json
const creds = require('./google-key.json'); 

const serviceAccountAuth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const SHEET_IDS = {
  ENERGIA: '1jA0FYHcrNS0zaX2dnyIkDf10DQeG6VHa_GA5MYdw0JE',
  TIC: '1j7RXTVGlvs9genTq3SAfoWVGTAO-7mX-B2HAvdUzYVQ'
};

// --- FUNCIÓN PARA REGISTRAR EN LA HOJA CORRECTA ---
async function registrarReclamo(datos, waId) {
  try {
    let spreadsheetId = '';
    let nombrePestaña = '';
    const servicio = datos.servicio ? datos.servicio.toUpperCase() : '';

    // Ruteo inteligente por Servicio y Pestaña
    if (servicio === 'ENERGÍA') {
      spreadsheetId = SHEET_IDS.ENERGIA;
      nombrePestaña = 'ENERGÍA';
    } else if (servicio === 'ALUMBRADO') {
      spreadsheetId = SHEET_IDS.ENERGIA;
      nombrePestaña = 'ALUMBRADO';
    } else if (servicio === 'INTERNET') {
      spreadsheetId = SHEET_IDS.TIC;
      nombrePestaña = 'INTERNET';
    } else if (servicio === 'TELEVISIÓN') {
      spreadsheetId = SHEET_IDS.TIC;
      nombrePestaña = 'TELEVISIÓN';
    } else if (servicio === 'TELEFONÍA') {
      spreadsheetId = SHEET_IDS.TIC;
      nombrePestaña = 'TELEFONÍA';
    } else {
      console.log("⚠️ Servicio no reconocido:", servicio);
      return null;
    }

    const doc = new GoogleSpreadsheet(spreadsheetId, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[nombrePestaña];

    if (!sheet) throw new Error(`No existe la pestaña ${nombrePestaña}`);

    // Lógica de ID Autoincremental
    const rows = await sheet.getRows();
    const ultimoId = rows.length > 0 ? parseInt(rows[rows.length - 1].get('ID')) : 0;
    const nuevoId = isNaN(ultimoId) ? 1 : ultimoId + 1;
    
    // Fecha y Hora local de Misiones
    const fechaHora = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });

    await sheet.addRow({
      "ID": nuevoId,
      "Estado": "pendiente",
      "Fecha y Hora": fechaHora,
      "Desde WhatsApp": waId,
      "Suministro": datos.suministro || "",
      "Nombre": datos.nombre || "",
      "Dirección": datos.direccion || "",
      "Teléfono": datos.telefono || "",
      "Descripción": datos.mensaje || "",
      "Marca GPS": ""
    });

    return nuevoId;
  } catch (error) {
    console.error("❌ Error en Sheets:", error.message);
    return null;
  }
}

// --- ENDPOINTS ---

// Health Check para Render
app.get('/', (req, res) => res.status(200).send('Servidor Cooperativa Activo'));

// 1. Verificación del Webhook para Meta (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === process.env.VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// 2. Procesamiento de Reclamos (POST)
app.post('/webhook', async (req, res) => {
  const body = req.body;

  // Respuesta rápida para pings de Meta (INIT/Health Checks)
  if (body.action === 'ping' || body.action === 'INIT') {
    return res.status(200).json({ data: { status: "active" } });
  }

  try {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    // Detectamos si el mensaje viene de un WhatsApp Flow
    if (message?.type === 'interactive' && message.interactive?.nfm_reply) {
      const nfm = message.interactive.nfm_reply;
      
      // DESENCRIPTACIÓN RSA/AES (Lógica de seguridad de Meta)
      const aesKey = crypto.privateDecrypt(
        { 
          key: PRIVATE_KEY, 
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, 
          oaepHash: "sha256" 
        },
        Buffer.from(nfm.encrypted_aes_key, 'base64')
      );

      const iv = Buffer.from(nfm.initial_vector, 'base64');
      const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, iv);
      
      const encryptedBuffer = Buffer.from(nfm.response_json, 'base64');
      const tag = encryptedBuffer.slice(-16);
      const data = encryptedBuffer.slice(0, -16);
      
      decipher.setAuthTag(tag);
      let decrypted = decipher.update(data, 'binary', 'utf8');
      decrypted += decipher.final('utf8');
      
      const flowData = JSON.parse(decrypted);
      const waId = message.from;

      console.log(`📩 Reclamo recibido de ${waId}:`, flowData);

      // Guardar en la hoja correspondiente
      const idReclamo = await registrarReclamo(flowData, waId);
      
      if (idReclamo) {
        console.log(`✅ Guardado con éxito en Sheets. ID: ${idReclamo}`);
      }
    }

    res.sendStatus(200); 
  } catch (e) {
    console.error("❌ Error procesando Webhook:", e.message);
    res.sendStatus(200); // Respondemos 200 igual para evitar reintentos fallidos de Meta
  }
});

app.listen(PORT, () => console.log(`🚀 Servidor Cooperativa en puerto ${PORT}`));
