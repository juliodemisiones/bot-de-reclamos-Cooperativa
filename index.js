const express = require('express');
const crypto = require('crypto');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
require('dotenv').config();

const app = express();

// === FIX 1: Parser robusto — acepta JSON y texto plano ===
// Necesario porque Meta a veces envía payloads con formato no estándar
app.use((req, res, next) => {
  express.json()(req, res, (err) => {
    if (err) {
      // Si falla el JSON parser, intentamos leer como texto
      express.text({ type: '*/*' })(req, res, (err2) => {
        if (err2) return next(err2);
        try {
          // Intentamos parsear el texto recibido
          if (typeof req.body === 'string') {
            req.body = JSON.parse(req.body);
          }
        } catch (e) {
          console.warn("⚠️ Body recibido no es JSON válido:", req.body?.substring?.(0, 100));
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

// === FIX 2: Validación de PRIVATE_KEY al arrancar (falla rápido y claro) ===
const PRIVATE_KEY = process.env.PRIVATE_KEY
  ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n')
  : null;

// Validaciones al iniciar
if (!WHATSAPP_ACCESS_TOKEN) {
  console.error("❌ ERROR: Falta la variable WHATSAPP_ACCESS_TOKEN en Render");
}
if (!VERIFY_TOKEN) {
  console.error("❌ ERROR: Falta la variable VERIFY_TOKEN en Render");
}
if (!PRIVATE_KEY) {
  console.error("❌ ERROR: Falta la variable PRIVATE_KEY en Render — la desencriptación de Flows no funcionará");
}

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
// FUNCIÓN PARA ENVIAR MENSAJES POR WHATSAPP
// =============================================
async function enviarMensajeWhatsApp(to, messageData) {
  const PHONE_NUMBER_ID = "1049500521582925";

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

// --- FUNCIÓN PARA REGISTRAR EN GOOGLE SHEETS ---
async function registrarReclamo(datos, waId) {
  try {
    let spreadsheetId = '';
    let nombrePestaña = '';

    // === FIX 3: Normalización de tildes para comparación segura ===
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

    if (!sheet) throw new Error(`No existe la pestaña "${nombrePestaña}" en el spreadsheet`);

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

// ======================
// ENDPOINTS
// ======================

// Health Check
app.get('/', (req, res) => {
  res.status(200).send('✅ Servidor Cooperativa Activo');
});

// === FIX 4: Verificación del Webhook (GET) con hub.mode validado ===
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log("✅ WEBHOOK VERIFICADO por Meta");
    res.status(200).send(challenge);
  } else {
    console.warn(`⚠️ Verificación fallida. Token recibido: "${token}", Esperado: "${VERIFY_TOKEN}"`);
    res.sendStatus(403);
  }
});

// === Procesamiento de mensajes (POST) ===
app.post('/webhook', async (req, res) => {
  // === FIX 5: Log inmediato para confirmar que Meta está llegando ===
  console.log("📬 POST recibido de Meta:", JSON.stringify(req.body).substring(0, 300));

  const body = req.body;

  // === FIX 6: Siempre responder 200 a Meta (incluso en casos no manejados) ===
  if (body.object !== 'whatsapp_business_account') {
    console.log("ℹ️ Objeto no reconocido:", body.object, "— respondiendo 200 igual");
    return res.sendStatus(200);
  }

  // Responder 200 a Meta de inmediato para evitar timeouts y reintentos
  res.sendStatus(200);

  // Procesamiento asíncrono DESPUÉS de responder
  try {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) {
      console.log("ℹ️ Sin mensajes en el payload (puede ser status update)");
      return;
    }

    console.log(`📨 Tipo de mensaje recibido: ${message.type} de ${message.from}`);

    // Detectamos si el mensaje viene de un WhatsApp Flow
    if (message.type === 'interactive' && message.interactive?.nfm_reply) {
      const nfm = message.interactive.nfm_reply;
      const waId = message.from;

      if (!PRIVATE_KEY) {
        console.error("❌ No se puede desencriptar: falta PRIVATE_KEY");
        return;
      }

      // Desencriptación RSA/AES del Flow
      const aesKey = crypto.privateDecrypt(
        {
          key: PRIVATE_KEY,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256"
        },
        Buffer.from(nfm.encrypted_aes_key, 'base64')
      );

      const iv = Buffer.from(nfm.initial_vector, 'base64');

      // === FIX 7: Detectar automáticamente si la clave es AES-128 (16 bytes) o AES-256 (32 bytes) ===
      const algoritmo = aesKey.length === 16 ? 'aes-128-gcm' : 'aes-256-gcm';
      console.log(`🔑 Usando algoritmo: ${algoritmo} (key length: ${aesKey.length} bytes)`);

      const decipher = crypto.createDecipheriv(algoritmo, aesKey, iv);

      const encryptedBuffer = Buffer.from(nfm.response_json, 'base64');
      const tag = encryptedBuffer.slice(-16);
      const data = encryptedBuffer.slice(0, -16);

      decipher.setAuthTag(tag);
      let decrypted = decipher.update(data, 'binary', 'utf8');
      decrypted += decipher.final('utf8');

      const flowData = JSON.parse(decrypted);
      console.log(`📩 Flow desencriptado de ${waId}:`, JSON.stringify(flowData));

      const idReclamo = await registrarReclamo(flowData, waId);

      if (idReclamo) {
        await enviarMensajeWhatsApp(waId, {
          type: "text",
          text: { body: `✅ Tu reclamo fue registrado con el ID: *${idReclamo}*. Te contactaremos a la brevedad.` }
        });
      } else {
        console.warn("⚠️ No se pudo guardar el reclamo — servicio no reconocido o error en Sheets");
      }
    } else {
      console.log("ℹ️ Mensaje recibido pero no es un Flow nfm_reply — ignorado");
    }
  } catch (e) {
    console.error("❌ Error procesando POST:", e.message, e.stack);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor Cooperativa en puerto ${PORT}`);
});
