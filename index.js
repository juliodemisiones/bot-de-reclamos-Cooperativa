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

// Validación importante al iniciar
if (!WHATSAPP_ACCESS_TOKEN) {
  console.error("❌ ERROR: Falta la variable WHATSAPP_ACCESS_TOKEN en Render");
  console.error("   Agrega tu token permanente en las variables de entorno.");
}

if (!VERIFY_TOKEN) {
  console.warn("⚠️  Advertencia: No se encontró VERIFY_TOKEN");
}

// --- CONFIGURACIÓN DE GOOGLE SHEETS ---
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

// =============================================
// FUNCIÓN PARA ENVIAR MENSAJES POR WHATSAPP
// =============================================
async function enviarMensajeWhatsApp(to, messageData) {
  if (!WHATSAPP_ACCESS_TOKEN) {
    console.error("❌ No se puede enviar mensaje: falta WHATSAPP_ACCESS_TOKEN");
    return false;
  }

  const PHONE_NUMBER_ID = "1049500521582925"; // ← Cambia si tu Phone Number ID es diferente

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
      console.error("❌ Error al enviar mensaje WhatsApp:", result);
      return false;
    }

    console.log(`✅ Mensaje enviado correctamente a ${to}`);
    return true;
  } catch (error) {
    console.error("❌ Error en fetch al enviar mensaje:", error.message);
    return false;
  }
}

// --- FUNCIÓN PARA REGISTRAR EN LA HOJA CORRECTA ---
async function registrarReclamo(datos, waId) {
  try {
    let spreadsheetId = '';
    let nombrePestaña = '';
    const servicio = datos.servicio ? datos.servicio.toUpperCase() : '';

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

// Health Check
app.get('/', (req, res) => {
  res.status(200).send('✅ Servidor Cooperativa Activo - WhatsApp Bot');
});

// Verificación del Webhook (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado correctamente");
    res.status(200).send(challenge);
  } else {
    console.warn("⚠️ Intento de verificación fallido");
    res.sendStatus(403);
  }
});

// Procesamiento de mensajes y Flows (POST)
app.post('/webhook', async (req, res) => {
  const body = req.body;

  // Respuesta rápida a pings de Meta
  if (body.action === 'ping' || body.action === 'INIT') {
    return res.status(200).json({ status: "active" });
  }

  try {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    // Procesar respuesta de WhatsApp Flow
    if (message?.type === 'interactive' && message.interactive?.nfm_reply) {
      const nfm = message.interactive.nfm_reply;
      const waId = message.from;

      // Desencriptación del Flow (Meta Flows)
      if (PRIVATE_KEY) {
        try {
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

          console.log(`📩 Flow recibido de ${waId}:`, flowData);

          const idReclamo = await registrarReclamo(flowData, waId);

          if (idReclamo) {
            console.log(`✅ Reclamo guardado con ID: ${idReclamo}`);

            // Opcional: Enviar confirmación al usuario
            await enviarMensajeWhatsApp(waId, {
              type: "text",
              text: { 
                body: `✅ ¡Reclamo registrado correctamente!\n\nID: ${idReclamo}\nPronto nos pondremos en contacto.` 
              }
            });
          }
        } catch (decError) {
          console.error("❌ Error al desencriptar Flow:", decError.message);
        }
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("❌ Error procesando webhook:", e.message);
    res.sendStatus(200); // Siempre responder 200 a Meta
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor Cooperativa corriendo en puerto ${PORT}`);
  if (WHATSAPP_ACCESS_TOKEN) {
    console.log("✅ Token de WhatsApp cargado correctamente");
  }
});
