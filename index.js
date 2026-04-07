const express = require('express');
const crypto = require('crypto');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
require('dotenv').config();

const app = express();
app.use(express.json());

// === CONFIGURACIÓN DE VARIABLES DE ENTORNO ===
const PORT = process.env.PORT || 10000;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PRIVATE_KEY = process.env.PRIVATE_KEY 
  ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') 
  : null;

// Validación al iniciar
if (!WHATSAPP_ACCESS_TOKEN) {
  console.error("❌ ERROR: Falta la variable WHATSAPP_ACCESS_TOKEN en Render");
}
if (!VERIFY_TOKEN) {
  console.error("❌ ERROR: Falta la variable VERIFY_TOKEN en Render");
}

// --- CONFIGURACIÓN DE GOOGLE SHEETS ---
// Asegúrate de que google-key.json esté en la raíz del proyecto en Render
let serviceAccountAuth;
try {
    const creds = require('./google-key.json');
    serviceAccountAuth = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
} catch (e) {
    console.error("❌ ERROR: No se pudo cargar google-key.json. Verifica que el archivo exista.");
}

const SHEET_IDS = {
  ENERGIA: '1jA0FYHcrNS0zaX2dnyIkDf10DQeG6VHa_GA5MYdw0JE',
  TIC: '1j7RXTVGlvs9genTq3SAfoWVGTAO-7mX-B2HAvdUzYVQ'
};

// =============================================
// FUNCIÓN PARA ENVIAR MENSAJES POR WHATSAPP
// =============================================
async function enviarMensajeWhatsApp(to, messageData) {
  const PHONE_NUMBER_ID = "1049500521582925"; // Tu ID Real confirmado

  try {
    const response = await fetch(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: to,
          ...messageData
        })
      }
    );

    const result = await response.json();
    if (!response.ok) {
      console.error("❌ Error API WhatsApp:", result);
      return false;
    }
    console.log(`✅ Mensaje enviado a ${to}`);
    return true;
  } catch (error) {
    console.error("❌ Error fetch WhatsApp:", error.message);
    return false;
  }
}

// --- FUNCIÓN PARA REGISTRAR EN GOOGLE SHEETS ---
async function registrarReclamo(datos, waId) {
  try {
    let spreadsheetId = '';
    let nombrePestaña = '';
    const servicio = datos.servicio ? datos.servicio.toUpperCase() : '';

    if (servicio === 'ENERGÍA' || servicio === 'ENERGIA') {
      spreadsheetId = SHEET_IDS.ENERGIA;
      nombrePestaña = 'ENERGÍA';
    } else if (servicio === 'ALUMBRADO') {
      spreadsheetId = SHEET_IDS.ENERGIA;
      nombrePestaña = 'ALUMBRADO';
    } else if (servicio === 'INTERNET') {
      spreadsheetId = SHEET_IDS.TIC;
      nombrePestaña = 'INTERNET';
    } else if (servicio === 'TELEVISIÓN' || servicio === 'TELEVISION') {
      spreadsheetId = SHEET_IDS.TIC;
      nombrePestaña = 'TELEVISIÓN';
    } else if (servicio === 'TELEFONÍA' || servicio === 'TELEFONIA') {
      spreadsheetId = SHEET_IDS.TIC;
      nombrePestaña = 'TELEFONÍA';
    } else {
      return null;
    }

    const doc = new GoogleSpreadsheet(spreadsheetId, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[nombrePestaña];
    
    const rows = await sheet.getRows();
    const ultimoId = rows.length > 0 ? parseInt(rows[rows.length - 1].get('ID') || 0) : 0;
    const nuevoId = isNaN(ultimoId) ? 1 : ultimoId + 1;

    const fechaHora = new Date().toLocaleString("es-AR", { 
      timeZone: "America/Argentina/Buenos_Aires" 
    });

    await sheet.addRow({
      "ID": nuevoId,
      "Estado": "pendiente",
      "Fecha y Hora": fechaHora,
      "Desde WhatsApp": waId,
      "Suministro": datos.suministro || "",
      "Nombre": datos.nombre || "",
      "Dirección": datos.direccion || "",
      "Teléfono": datos.telefono || "",
      "Descripción": datos.mensaje || datos.descripcion || "",
      "Marca GPS": ""
    });

    return nuevoId;
  } catch (error) {
    console.error("❌ Error en Sheets:", error.message);
    return null;
  }
}

// ======================
// ENDPOINTS
// ======================

app.get('/', (req, res) => {
  res.status(200).send('✅ Servidor Cooperativa Activo');
});

// Verificación del Webhook (GET) - CORREGIDO
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log("✅ WEBHOOK_VERIFIED");
    res.status(200).send(challenge);
  } else {
    console.warn(`⚠️ Verificación fallida. Recibido: ${token}, Esperado: ${VERIFY_TOKEN}`);
    res.sendStatus(403);
  }
});

// Procesamiento de mensajes (POST)
app.post('/webhook', async (req, res) => {
  const body = req.body;

  // Manejo de validaciones de Meta
  if (body.object === 'whatsapp_business_account') {
    try {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const message = value?.messages?.[0];

      if (message?.type === 'interactive' && message.interactive?.nfm_reply) {
        const nfm = message.interactive.nfm_reply;
        const waId = message.from;

        if (PRIVATE_KEY) {
          // Lógica de desencriptación de WhatsApp Flows
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
          console.log(`📩 Flow recibido:`, flowData);

          const idReclamo = await registrarReclamo(flowData, waId);

          if (idReclamo) {
            await enviarMensajeWhatsApp(waId, {
              type: "text",
              text: { body: `✅ Reclamo registrado con ID: ${idReclamo}` }
            });
          }
        }
      }
      res.sendStatus(200);
    } catch (e) {
      console.error("❌ Error procesando POST:", e.message);
      res.sendStatus(200);
    }
  } else {
    res.sendStatus(404);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
});
