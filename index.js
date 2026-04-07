// === VERSIÓN LIMPIA - SIN SPREAD OPERATORS (Compatible con Node antiguo) ===
const express = require('express');
const crypto = require('crypto');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// Middlewares simples y seguros para Meta
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: 'text/plain', limit: '10mb' }));

const PRIVATE_KEY = process.env.PRIVATE_KEY 
  ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') 
  : null;

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
  console.error("❌ ERROR: No se pudo cargar google-key.json:", e.message);
}

const SHEET_IDS = {
  ENERGIA: '1jA0FYHcrNS0zaX2dnyIkDf10DQeG6VHa_GA5MYdw0JE',
  TIC: '1j7RXTVGlvs9genTq3SAfoWVGTAO-7mX-B2HAvdUzYVQ'
};

// ======================
// FUNCIÓN ENVIAR MENSAJE (sin spread)
async function enviarMensajeWhatsApp(to, messageData) {
  try {
    const bodyPayload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to
    };
    
    // Copia manual de las propiedades de messageData
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
// Otras funciones (sin cambios importantes)
async function enviarBienvenidaYPlantilla(waId) {
  // Mensaje de texto
  await enviarMensajeWhatsApp(waId, {
    type: "text",
    text: {
      body: "Se ha comunicado con la Cooperativa Luz y Fuerza.\n\n" +
            "Para dar aviso de corte o falla en alguno de nuestros servicios, a continuación complete el registro de reclamo.\n\n" +
            "📋 Tenga a mano su *número de suministro eléctrico* (es un dato necesario).\n\n" +
            "Para consultas administrativas comuníquese al fijo *476000* de lunes a viernes de 6:30 a 13 hs."
    }
  });

  // Plantilla con Flow
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
            {
              type: "action",
              action: {
                flow_token: `${waId}_${Date.now()}`
              }
            }
          ]
        }
      ]
    }
  });
}

async function registrarReclamo(datos, waId) {
  try {
    let spreadsheetId = '';
    let nombrePestaña = '';
    const normalizar = (str) =>
      str ? str.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") : '';

    const servicio = normalizar(datos.servicio);

    if (servicio === 'ENERGIA') {
      spreadsheetId = SHEET_IDS.ENERGIA;
      nombrePestaña = 'ENERGÍA';
    } else if (servicio === 'ALUMBRADO') {
      spreadsheetId = SHEET_IDS.ENERGIA;
      nombrePestaña = 'ALUMBRADO';
    } else if (servicio === 'INTERNET') {
      spreadsheetId = SHEET_IDS.TIC;
      nombrePestaña = 'INTERNET';
    } else if (servicio === 'TELEVISION') {
      spreadsheetId = SHEET_IDS.TIC;
      nombrePestaña = 'TELEVISIÓN';
    } else if (servicio === 'TELEFONIA') {
      spreadsheetId = SHEET_IDS.TIC;
      nombrePestaña = 'TELEFONÍA';
    } else {
      console.warn("⚠️ Servicio no reconocido:", datos.servicio);
      return null;
    }

    const doc = new GoogleSpreadsheet(spreadsheetId, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[nombrePestaña];
    if (!sheet) throw new Error(`No existe la pestaña "${nombrePestaña}"`);

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

    console.log(`✅ Reclamo ID ${nuevoId} guardado en "${nombrePestaña}"`);
    return nuevoId;
  } catch (error) {
    console.error("❌ Error en Sheets:", error.message);
    return null;
  }
}

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
      console.error(`❌ Error en sheet ${nombre}:`, e.message);
    }
  }
  console.warn(`⚠️ No se encontró reclamo para ${waId}`);
  return false;
}

// ======================
// FUNCIONES DE CRIPTOGRAFÍA
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
  
  const encrypted = Buffer.concat([
    cipher.update(responseStr, 'utf8'),
    cipher.final()
  ]);
  
  const tag = cipher.getAuthTag();
  return Buffer.concat([encrypted, tag]).toString('base64');
}

// ======================
// MANEJADOR DEL FLOW
async function manejarFlow(body, res) {
  if (!body || !body.encrypted_aes_key || !body.initial_vector || !body.encrypted_flow_data) {
    return false;
  }

  console.log("🔄 Procesando request de Flow");

  if (!PRIVATE_KEY) {
    console.error("❌ Falta PRIVATE_KEY");
    res.status(500).send('Error de configuración');
    return true;
  }

  try {
    const { flowData, aesKey, iv } = desencriptarFlow(
      body.encrypted_aes_key,
      body.initial_vector,
      body.encrypted_flow_data
    );

    console.log("Flow action:", flowData.action || "desconocido");

    let responseData = { data: { status: "active" } };

    if (flowData.action === 'INIT') {
      responseData = { screen: "INGRESO_SUMINISTRO", data: {} };
    } else if (flowData.action === 'data_exchange') {
      responseData = {
        screen: flowData.screen,
        data: flowData.data || {}
      };
    }

    const encryptedResponse = encriptarRespuestaFlow(aesKey, iv, responseData);

    res.set('Content-Type', 'text/plain');
    res.status(200).send(encryptedResponse);
    console.log("✅ Flow respondido con Base64 correctamente");
    return true;

  } catch (e) {
    console.error("❌ Error procesando Flow:", e.message);
    res.status(200).json({ data: { status: "active" } }); // fallback seguro
    return true;
  }
}

// ======================
// ROUTES
app.get('/', (req, res) => res.status(200).send('✅ Servidor Cooperativa Activo'));

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  console.log("📬 POST /webhook recibido");

  const body = req.body;

  // Prioridad máxima: ¿Es un request de Flow?
  const esFlow = await manejarFlow(body, res);
  if (esFlow) return;

  // Procesamiento normal de mensajes WhatsApp
  if (body.object !== 'whatsapp_business_account') {
    return res.sendStatus(200);
  }

  res.sendStatus(200);

  try {
    const entry = body.entry && body.entry[0];
    const changes = entry && entry.changes && entry.changes[0];
    const value = changes && changes.value;
    const message = value && value.messages && value.messages[0];

    if (!message) return;

    const waId = message.from;

    if (message.type === 'interactive' && message.interactive && message.interactive.nfm_reply) {
      const nfm = message.interactive.nfm_reply;
      const { flowData } = desencriptarFlow(
        nfm.encrypted_aes_key,
        nfm.initial_vector,
        nfm.response_json
      );

      const idReclamo = await registrarReclamo(flowData, waId);
      if (idReclamo) {
        await enviarMensajeWhatsApp(waId, {
          type: "text",
          text: {
            body: `✅ Tu reclamo fue registrado con el ID: *${idReclamo}*.\n\nSi querés, compartí tu ubicación 📍`
          }
        });
      }
    } 
    else if (message.type === 'location') {
      const location = message.location;
      const lat = location.latitude;
      const lon = location.longitude;
      await guardarUbicacion(waId, lat, lon);
      await enviarMensajeWhatsApp(waId, {
        type: "text",
        text: { body: "📍 Gracias por compartir la ubicación." }
      });
    } 
    else {
      await enviarBienvenidaYPlantilla(waId);
    }
  } catch (e) {
    console.error("❌ Error procesando mensaje:", e.message);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor Cooperativa corriendo en puerto ${PORT}`);
});
