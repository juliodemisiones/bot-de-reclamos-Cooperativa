// === VERSIÓN COMPLETA Y LISTA PARA USAR ===
const express = require('express');
const crypto = require('crypto');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: 'text/plain', limit: '10mb' }));

const PRIVATE_KEY = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') : null;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = "1049500521582925";

// Configuración Google Sheets
let serviceAccountAuth;
try {
  const creds = require('./google-key.json');
  serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  console.log("✅ google-key.json cargado correctamente");
} catch (e) {
  console.error("❌ ERROR google-key.json:", e.message);
}

const SHEET_IDS = {
  ENERGIA: '1jA0FYHcrNS0zaX2dnyIkDf10DQeG6VHa_GA5MYdw0JE',
  TIC: '1j7RXTVGlvs9genTq3SAfoWVGTAO-7mX-B2HAvdUzYVQ'
};

// ======================
// FUNCIÓN ENVIAR MENSAJE
async function enviarMensajeWhatsApp(to, messageData) {
  try {
    const bodyPayload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to
    };
    Object.keys(messageData).forEach(key => {
      bodyPayload[key] = messageData[key];
    });

    const response = await fetch(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(bodyPayload)
      }
    );

    const result = await response.json();
    if (!response.ok) {
      console.error("❌ Error API WhatsApp:", JSON.stringify(result));
      return false;
    }
    console.log(`✅ Mensaje enviado a ${to}`);
    return true;
  } catch (error) {
    console.error("❌ Error fetch WhatsApp:", error.message);
    return false;
  }
}

// ======================
// BIENVENIDA + PLANTILLA
async function enviarBienvenidaYPlantilla(waId) {
  await enviarMensajeWhatsApp(waId, {
    type: "text",
    text: {
      body: "Se ha comunicado con la Cooperativa Luz y Fuerza.\n\n" +
            "Para dar aviso de corte o falla complete el registro.\n\n" +
            "📋 Tenga a mano su número de suministro eléctrico.\n\n" +
            "Consultas administrativas: *476000*"
    }
  });

  await enviarMensajeWhatsApp(waId, {
    type: "template",
    template: {
      name: "reclamos_v2",
      language: { code: "es_AR" },
      components: [
        {
          type: "button",
          sub_type: "flow",
          index: "0",
          parameters: [
            { type: "action", action: { flow_token: `${waId}_${Date.now()}` } }
          ]
        }
      ]
    }
  });
}

// ======================
// REGISTRAR RECLAMO EN SHEETS
async function registrarReclamo(datos, waId) {
  try {
    let spreadsheetId = '';
    let nombrePestaña = '';
    const normalizar = (str) => str ? str.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") : '';
    const servicio = normalizar(datos.servicio);

    if (servicio === 'ENERGIA') { spreadsheetId = SHEET_IDS.ENERGIA; nombrePestaña = 'ENERGÍA'; }
    else if (servicio === 'ALUMBRADO') { spreadsheetId = SHEET_IDS.ENERGIA; nombrePestaña = 'ALUMBRADO'; }
    else if (servicio === 'INTERNET') { spreadsheetId = SHEET_IDS.TIC; nombrePestaña = 'INTERNET'; }
    else if (servicio === 'TELEVISION') { spreadsheetId = SHEET_IDS.TIC; nombrePestaña = 'TELEVISIÓN'; }
    else if (servicio === 'TELEFONIA') { spreadsheetId = SHEET_IDS.TIC; nombrePestaña = 'TELEFONÍA'; }
    else {
      console.warn("⚠️ Servicio no reconocido:", datos.servicio);
      return null;
    }

    const doc = new GoogleSpreadsheet(spreadsheetId, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[nombrePestaña];
    if (!sheet) throw new Error(`No existe pestaña ${nombrePestaña}`);

    const rows = await sheet.getRows();
    const ultimoId = rows.length > 0 ? parseInt(rows[rows.length - 1].get('ID') || 0) : 0;
    const nuevoId = isNaN(ultimoId) ? 1 : ultimoId + 1;

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
      "Descripción": datos.mensaje || datos.descripcion || "",
      "Marca GPS": ""
    });

    console.log(`✅ Reclamo ID ${nuevoId} guardado`);
    return nuevoId;
  } catch (error) {
    console.error("❌ Error Sheets:", error.message);
    return null;
  }
}

// ======================
// GUARDAR UBICACIÓN
async function guardarUbicacion(waId, latitud, longitud) {
  const googleMapsLink = `https://maps.google.com/?q=${latitud},${longitud}`;
  const valorGPS = `${latitud}, ${longitud} — ${googleMapsLink}`;

  for (const [nombre, spreadsheetId] of Object.entries(SHEET_IDS)) {
    try {
      const doc = new GoogleSpreadsheet(spreadsheetId, serviceAccountAuth);
      await doc.loadInfo();
      for (const sheet of Object.values(doc.sheetsByTitle)) {
        const rows = await sheet.getRows();
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].get('Desde WhatsApp') === waId) {
            rows[i].set('Marca GPS', valorGPS);
            await rows[i].save();
            console.log(`✅ Ubicación guardada para ${waId}`);
            return true;
          }
        }
      }
    } catch (e) {
      console.error(`❌ Error sheet ${nombre}:`, e.message);
    }
  }
  console.warn(`⚠️ No se encontró reclamo para ${waId}`);
  return false;
}

// ======================
// CRIPTOGRAFÍA
function desencriptarFlow(encryptedAesKey, initialVector, encryptedData) {
  const aesKey = crypto.privateDecrypt({
    key: PRIVATE_KEY,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha256"
  }, Buffer.from(encryptedAesKey, 'base64'));

  const algoritmo = aesKey.length === 16 ? 'aes-128-gcm' : 'aes-256-gcm';
  const iv = Buffer.from(initialVector, 'base64');
  const decipher = crypto.createDecipheriv(algoritmo, aesKey, iv);
  const encryptedBuffer = Buffer.from(encryptedData, 'base64');
  const tag = encryptedBuffer.slice(-16);
  const data = encryptedBuffer.slice(0, -16);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(data, 'binary', 'utf8');
  decrypted += decipher.final('utf8');
  return { flowData: JSON.parse(decrypted), aesKey, iv };
}

function encriptarRespuestaFlow(aesKey, iv, responseData) {
  const algoritmo = aesKey.length === 16 ? 'aes-128-gcm' : 'aes-256-gcm';
  const ivInvertido = Buffer.from(iv).reverse();
  const cipher = crypto.createCipheriv(algoritmo, aesKey, ivInvertido);
  const responseStr = JSON.stringify(responseData);
  const encrypted = Buffer.concat([cipher.update(responseStr, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([encrypted, tag]).toString('base64');
}

// ======================
// MANEJADOR DEL FLOW (con logs detallados)
async function manejarFlow(body, res, ruta = 'desconocida') {
  console.log(`🔍 [${ruta}] POST recibido - Keys:`, Object.keys(body || {}));

  if (!body?.encrypted_aes_key || !body?.initial_vector || !body?.encrypted_flow_data) {
    console.log(`⚠️ [${ruta}] No es payload de Flow`);
    return false;
  }

  console.log(`🔄 [${ruta}] Flow detectado - Procesando...`);

  if (!PRIVATE_KEY) {
    console.error(`❌ [${ruta}] Falta PRIVATE_KEY`);
    res.status(500).send('Error config');
    return true;
  }

  try {
    const { flowData, aesKey, iv } = desencriptarFlow(body.encrypted_aes_key, body.initial_vector, body.encrypted_flow_data);
    console.log(`🔄 [${ruta}] Action: ${flowData.action} | Screen: ${flowData.screen || 'ninguna'}`);

    let responseData = { data: { status: "active" } };

    if (flowData.action === 'INIT') {
      responseData = { screen: "INGRESO_SUMINISTRO", data: {} };
    } else if (flowData.action === 'data_exchange') {
      responseData = { screen: flowData.screen, data: flowData.data || {} };
    }

    const encryptedResponse = encriptarRespuestaFlow(aesKey, iv, responseData);
    res.set('Content-Type', 'text/plain');
    res.status(200).send(encryptedResponse);

    console.log(`✅ [${ruta}] Respondido correctamente con Base64`);
    return true;
  } catch (e) {
    console.error(`❌ [${ruta}] Error:`, e.message);
    res.status(200).json({ data: { status: "active" } });
    return true;
  }
}

// ======================
// ROUTES
app.get('/', (req, res) => res.send('✅ Servidor Activo'));

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const esFlow = await manejarFlow(req.body, res, '/webhook');
  if (esFlow) return;

  // Procesamiento normal de mensajes WhatsApp (mismo que tenías antes)
  if (req.body.object !== 'whatsapp_business_account') return res.sendStatus(200);
  res.sendStatus(200);

  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;
    const waId = message.from;

    if (message.type === 'interactive' && message.interactive?.nfm_reply) {
      const nfm = message.interactive.nfm_reply;
      const { flowData } = desencriptarFlow(nfm.encrypted_aes_key, nfm.initial_vector, nfm.response_json);
      const idReclamo = await registrarReclamo(flowData, waId);
      if (idReclamo) {
        await enviarMensajeWhatsApp(waId, { type: "text", text: { body: `✅ Reclamo ID: *${idReclamo}*\n\nCompartí tu ubicación si querés 📍` } });
      }
    } else if (message.type === 'location') {
      await guardarUbicacion(waId, message.location.latitude, message.location.longitude);
      await enviarMensajeWhatsApp(waId, { type: "text", text: { body: "📍 Gracias por la ubicación." } });
    } else {
      await enviarBienvenidaYPlantilla(waId);
    }
  } catch (e) {
    console.error("❌ Error procesando mensaje:", e.message);
  }
});

app.post('/flow', async (req, res) => {
  await manejarFlow(req.body, res, '/flow');
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
