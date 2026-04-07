const express = require('express');
const crypto = require('crypto');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
require('dotenv').config();

const app = express();

// === Parser robusto — acepta JSON y texto plano ===
app.use((req, res, next) => {
  express.json()(req, res, (err) => {
    if (err) {
      express.text({ type: '*/*' })(req, res, (err2) => {
        if (err2) return next(err2);
        try {
          if (typeof req.body === 'string') req.body = JSON.parse(req.body);
        } catch (e) {
          console.warn("⚠️ Body no es JSON válido:", req.body?.substring?.(0, 100));
          req.body = {};
        }
        next();
      });
    } else {
      next();
    }
  });
});

// === CONFIGURACIÓN DE VARIABLES DE ENTORNO ===
const PORT = process.env.PORT || 10000;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PRIVATE_KEY = process.env.PRIVATE_KEY
  ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n')
  : null;
const PHONE_NUMBER_ID = "1049500521582925";
const FLOW_ID = "4268330126739070";

// Validaciones al iniciar
if (!WHATSAPP_ACCESS_TOKEN) console.error("❌ ERROR: Falta WHATSAPP_ACCESS_TOKEN en Render");
if (!VERIFY_TOKEN)          console.error("❌ ERROR: Falta VERIFY_TOKEN en Render");
if (!PRIVATE_KEY)           console.error("❌ ERROR: Falta PRIVATE_KEY en Render");

// --- CONFIGURACIÓN DE GOOGLE SHEETS ---
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

// =============================================
// FUNCIÓN GENÉRICA PARA ENVIAR MENSAJES
// =============================================
async function enviarMensajeWhatsApp(to, messageData) {
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

// =============================================
// FUNCIÓN: Texto de bienvenida + plantilla con Flow
// =============================================
async function enviarBienvenidaYPlantilla(waId) {
  // 1. Mensaje de texto con la información
  await enviarMensajeWhatsApp(waId, {
    type: "text",
    text: {
      body:
        "Se ha comunicado con la Cooperativa Luz y Fuerza.\n\n" +
        "Para dar aviso de corte o falla en alguno de nuestros servicios, a continuación complete el registro de reclamo.\n\n" +
        "📋 Tenga a mano su *número de suministro eléctrico* (es un dato necesario).\n\n" +
        "Para consultas administrativas comuníquese al fijo *476000* de lunes a viernes de 6:30 a 13 hs."
    }
  });

  // 2. Plantilla con botón que abre el Flow
  // El componente "button" con sub_type "FLOW" es requerido por Meta cuando la plantilla tiene botón de Flow
  await enviarMensajeWhatsApp(waId, {
    type: "template",
    template: {
      name: "reclamos_v2",
      language: {
        code: "es_AR"
      },
      components: [
        {
          type: "button",
          sub_type: "flow",
          index: "0",
          parameters: [
            {
              type: "action",
              action: {
                flow_token: `${waId}_${Date.now()}` // Token único por usuario+timestamp
              }
            }
          ]
        }
      ]
    }
  });
}

// =============================================
// FUNCIÓN: Registrar reclamo en Google Sheets
// =============================================
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
      console.warn("⚠️ Servicio no reconocido:", datos.servicio, "→ normalizado:", servicio);
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

    console.log(`✅ Reclamo ID ${nuevoId} guardado en pestaña "${nombrePestaña}"`);
    return nuevoId;
  } catch (error) {
    console.error("❌ Error en Sheets:", error.message);
    return null;
  }
}

// =============================================
// FUNCIÓN: Guardar ubicación en el último reclamo del usuario
// =============================================
async function guardarUbicacion(waId, latitud, longitud) {
  // Buscamos en ambos sheets el último reclamo del usuario y actualizamos Marca GPS
  const marcaGPS = `${latitud}, ${longitud}`;
  const googleMapsLink = `https://maps.google.com/?q=${latitud},${longitud}`;
  const valorGPS = `${marcaGPS} — ${googleMapsLink}`;

  for (const [nombre, spreadsheetId] of Object.entries(SHEET_IDS)) {
    try {
      const doc = new GoogleSpreadsheet(spreadsheetId, serviceAccountAuth);
      await doc.loadInfo();

      for (const sheet of Object.values(doc.sheetsByTitle)) {
        const rows = await sheet.getRows();
        // Buscamos de atrás hacia adelante el último reclamo de este waId
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].get('Desde WhatsApp') === waId) {
            rows[i].set('Marca GPS', valorGPS);
            await rows[i].save();
            console.log(`✅ Ubicación guardada para ${waId} en hoja "${sheet.title}" ID ${rows[i].get('ID')}`);
            return true;
          }
        }
      }
    } catch (e) {
      console.error(`❌ Error buscando en sheet ${nombre}:`, e.message);
    }
  }

  console.warn(`⚠️ No se encontró reclamo previo de ${waId} para guardar ubicación`);
  return false;
}

// =============================================
// FUNCIÓN: Desencriptar respuesta del Flow
// =============================================
function desencriptarFlow(encryptedAesKey, initialVector, encryptedData) {
  const aesKey = crypto.privateDecrypt(
    {
      key: PRIVATE_KEY,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256"
    },
    Buffer.from(encryptedAesKey, 'base64')
  );

  const algoritmo = aesKey.length === 16 ? 'aes-128-gcm' : 'aes-256-gcm';
  console.log(`🔑 Algoritmo: ${algoritmo} (key: ${aesKey.length} bytes)`);

  const iv = Buffer.from(initialVector, 'base64');
  const decipher = crypto.createDecipheriv(algoritmo, aesKey, iv);

  const encryptedBuffer = Buffer.from(encryptedData, 'base64');
  const tag = encryptedBuffer.slice(-16);
  const data = encryptedBuffer.slice(0, -16);

  decipher.setAuthTag(tag);
  let decrypted = decipher.update(data, 'binary', 'utf8');
  decrypted += decipher.final('utf8');

  return JSON.parse(decrypted);
}

// ======================
// ENDPOINTS
// ======================

app.get('/', (req, res) => res.status(200).send('✅ Servidor Cooperativa Activo'));

// Verificación del Webhook (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log("✅ WEBHOOK VERIFICADO por Meta");
    res.status(200).send(challenge);
  } else {
    console.warn(`⚠️ Verificación fallida. Token recibido: "${token}"`);
    res.sendStatus(403);
  }
});

// =============================================
// ENDPOINT DEL FLOW (Meta llama a este endpoint
// para intercambiar datos entre pantallas del Flow)
// =============================================
app.post('/flow', async (req, res) => {
  console.log("🔄 POST recibido en /flow");

  try {
    if (!PRIVATE_KEY) {
      console.error("❌ Falta PRIVATE_KEY para desencriptar el Flow");
      return res.status(500).send('Error de configuración');
    }

    const { encrypted_aes_key, initial_vector, encrypted_flow_data } = req.body;

    const flowData = desencriptarFlow(encrypted_aes_key, initial_vector, encrypted_flow_data);
    console.log("🔄 Flow data recibida:", JSON.stringify(flowData));

    const { action, screen, data } = flowData;

    // Meta requiere que el endpoint del Flow responda con datos encriptados
    // Para pantallas intermedias respondemos con datos vacíos (el Flow maneja su propio estado)
    // Para la pantalla final (PANTALLA_CIERRE) respondemos con el cierre
    let responseData = {};

    if (action === 'INIT') {
      // Primera carga del Flow
      responseData = { screen: "INGRESO_SUMINISTRO", data: {} };
    } else if (screen === 'PANTALLA_CIERRE' || action === 'data_exchange') {
      // El usuario completó el Flow — los datos vienen en el webhook POST normal como nfm_reply
      responseData = { screen: "SUCCESS", data: {} };
    } else {
      // Navegación entre pantallas intermedias
      responseData = { screen: screen, data: data || {} };
    }

    // Encriptar la respuesta de vuelta (Meta lo requiere)
    const aesKey = crypto.privateDecrypt(
      {
        key: PRIVATE_KEY,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256"
      },
      Buffer.from(encrypted_aes_key, 'base64')
    );

    const iv = Buffer.from(initial_vector, 'base64');
    const algoritmo = aesKey.length === 16 ? 'aes-128-gcm' : 'aes-256-gcm';
    const cipher = crypto.createCipheriv(algoritmo, aesKey, iv);

    const responseStr = JSON.stringify(responseData);
    let encrypted = cipher.update(responseStr, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const tag = cipher.getAuthTag();

    // Concatenar datos encriptados + tag de autenticación
    const encryptedResponse = Buffer.concat([
      Buffer.from(encrypted, 'base64'),
      tag
    ]).toString('base64');

    res.status(200).json({ encrypted_flow_data: encryptedResponse });

  } catch (e) {
    console.error("❌ Error en /flow:", e.message, e.stack);
    res.status(500).send('Error procesando Flow');
  }
});

// =============================================
// ENDPOINT PRINCIPAL DEL WEBHOOK (POST)
// =============================================
app.post('/webhook', async (req, res) => {
  console.log("📬 POST recibido de Meta:", JSON.stringify(req.body).substring(0, 300));

  const body = req.body;

  if (body.object !== 'whatsapp_business_account') {
    console.log("ℹ️ Objeto no reconocido:", body.object);
    return res.sendStatus(200);
  }

  // Responder 200 a Meta de inmediato
  res.sendStatus(200);

  try {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) {
      console.log("ℹ️ Sin mensajes en el payload (status update)");
      return;
    }

    const waId = message.from;
    console.log(`📨 Tipo de mensaje: "${message.type}" de ${waId}`);

    // === CASO 1: Respuesta del Flow completado (nfm_reply) ===
    if (message.type === 'interactive' && message.interactive?.nfm_reply) {
      const nfm = message.interactive.nfm_reply;

      if (!PRIVATE_KEY) {
        console.error("❌ No se puede desencriptar: falta PRIVATE_KEY");
        return;
      }

      const flowData = desencriptarFlow(
        nfm.encrypted_aes_key,
        nfm.initial_vector,
        nfm.response_json
      );
      console.log(`📩 Flow completado por ${waId}:`, JSON.stringify(flowData));

      const idReclamo = await registrarReclamo(flowData, waId);

      if (idReclamo) {
        await enviarMensajeWhatsApp(waId, {
          type: "text",
          text: {
            body:
              `✅ Tu reclamo fue registrado con el ID: *${idReclamo}*.\n\n` +
              `Si querés, podés compartir tu *ubicación* para que podamos localizar la falla más rápido. 📍`
          }
        });
      } else {
        console.warn("⚠️ No se pudo guardar el reclamo");
      }

    // === CASO 2: Ubicación compartida post-Flow ===
    } else if (message.type === 'location') {
      const { latitude, longitude } = message.location;
      console.log(`📍 Ubicación recibida de ${waId}: ${latitude}, ${longitude}`);

      const guardado = await guardarUbicacion(waId, latitude, longitude);

      await enviarMensajeWhatsApp(waId, {
        type: "text",
        text: {
          body: guardado
            ? "📍 Gracias por compartir la ubicación de la falla. Fue registrada en tu reclamo."
            : "📍 Ubicación recibida, pero no encontramos un reclamo reciente asociado a tu número."
        }
      });

    // === CASO 3: Cualquier otro mensaje → bienvenida + plantilla ===
    } else {
      console.log(`💬 Mensaje entrante de ${waId} — enviando bienvenida y plantilla`);
      await enviarBienvenidaYPlantilla(waId);
    }

  } catch (e) {
    console.error("❌ Error procesando POST:", e.message, e.stack);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor Cooperativa en puerto ${PORT}`);
});
