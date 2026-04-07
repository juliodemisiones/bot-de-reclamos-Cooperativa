const express = require('express');
const crypto = require('crypto');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
require('dotenv').config();

const app = express();

// =============================================
// 1️⃣  RAW BODY — captura el body crudo en TODAS las rutas
//     DEBE ir ANTES de cualquier otro parser.
//     Meta puede enviar requests de Flow tanto a /flow
//     como a /webhook (según la config de la app).
//     El raw body queda en req.rawBody para uso interno.
// =============================================
app.use((req, res, next) => {
  let rawBody = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { rawBody += chunk; });
  req.on('end', () => {
    req.rawBody = rawBody;
    try {
      req.body = JSON.parse(rawBody);
    } catch (e) {
      req.body = {};
    }
    next();
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

if (!WHATSAPP_ACCESS_TOKEN) console.error('❌ ERROR: Falta WHATSAPP_ACCESS_TOKEN en Render');
if (!VERIFY_TOKEN)          console.error('❌ ERROR: Falta VERIFY_TOKEN en Render');
if (!PRIVATE_KEY)           console.error('❌ ERROR: Falta PRIVATE_KEY en Render');

// --- CONFIGURACIÓN DE GOOGLE SHEETS ---
let serviceAccountAuth;
try {
  const creds = require('./google-key.json');
  serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  console.log('✅ google-key.json cargado correctamente');
} catch (e) {
  console.error('❌ ERROR: No se pudo cargar google-key.json:', e.message);
}

const SHEET_IDS = {
  ENERGIA: '1jA0FYHcrNS0zaX2dnyIkDf10DQeG6VHa_GA5MYdw0JE',
  TIC:     '1j7RXTVGlvs9genTq3SAfoWVGTAO-7mX-B2HAvdUzYVQ'
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
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          ...messageData
        })
      }
    );
    const result = await response.json();
    if (!response.ok) {
      console.error('❌ Error API WhatsApp:', JSON.stringify(result));
      return false;
    }
    console.log(`✅ Mensaje enviado a ${to}`);
    return true;
  } catch (error) {
    console.error('❌ Error fetch WhatsApp:', error.message);
    return false;
  }
}

// =============================================
// FUNCIÓN: Texto de bienvenida + plantilla con Flow
// =============================================
async function enviarBienvenidaYPlantilla(waId) {
  await enviarMensajeWhatsApp(waId, {
    type: 'text',
    text: {
      body:
        'Se ha comunicado con la Cooperativa Luz y Fuerza.\n\n' +
        'Para dar aviso de corte o falla en alguno de nuestros servicios, a continuación complete el registro de reclamo.\n\n' +
        '📋 Tenga a mano su *número de suministro eléctrico* (es un dato necesario).\n\n' +
        'Para consultas administrativas comuníquese al fijo *476000* de lunes a viernes de 6:30 a 13 hs.'
    }
  });

  await enviarMensajeWhatsApp(waId, {
    type: 'template',
    template: {
      name: 'reclamos_v3',
      language: { code: 'es_AR' },
      components: [
        {
          type: 'button',
          sub_type: 'flow',
          index: '0',
          parameters: [
            {
              type: 'action',
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

// =============================================
// FUNCIÓN: Registrar reclamo en Google Sheets
// =============================================
async function registrarReclamo(datos, waId) {
  try {
    let spreadsheetId = '';
    let nombrePestaña = '';

    const normalizar = (str) =>
      str ? str.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') : '';

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
      console.warn('⚠️ Servicio no reconocido:', datos.servicio, '→ normalizado:', servicio);
      return null;
    }

    const doc = new GoogleSpreadsheet(spreadsheetId, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[nombrePestaña];

    if (!sheet) throw new Error(`No existe la pestaña "${nombrePestaña}"`);

    const rows = await sheet.getRows();
    const ultimoId = rows.length > 0 ? parseInt(rows[rows.length - 1].get('ID') || 0) : 0;
    const nuevoId = isNaN(ultimoId) ? 1 : ultimoId + 1;

    const fechaHora = new Date().toLocaleString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires'
    });

    await sheet.addRow({
      'ID': nuevoId,
      'Estado': 'pendiente',
      'Fecha y Hora': fechaHora,
      'Desde WhatsApp': waId,
      'Suministro': datos.suministro || '',
      'Nombre': datos.nombre || '',
      'Dirección': datos.direccion || '',
      'Teléfono': datos.telefono || '',
      'Descripción': datos.mensaje || datos.descripcion || '',
      'Marca GPS': ''
    });

    console.log(`✅ Reclamo ID ${nuevoId} guardado en pestaña "${nombrePestaña}"`);
    return nuevoId;
  } catch (error) {
    console.error('❌ Error en Sheets:', error.message);
    return null;
  }
}

// =============================================
// FUNCIÓN: Guardar ubicación en el último reclamo
// =============================================
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
            console.log(`✅ Ubicación guardada para ${waId} en hoja "${sheet.title}"`);
            return true;
          }
        }
      }
    } catch (e) {
      console.error(`❌ Error buscando en sheet ${nombre}:`, e.message);
    }
  }
  console.warn(`⚠️ No se encontró reclamo previo de ${waId}`);
  return false;
}

// =============================================
// FUNCIÓN: Desencriptar datos del Flow
// =============================================
function desencriptarFlow(encryptedAesKey, initialVector, encryptedData) {
  const aesKey = crypto.privateDecrypt(
    {
      key: PRIVATE_KEY,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    Buffer.from(encryptedAesKey, 'base64')
  );

  const algoritmo = aesKey.length === 16 ? 'aes-128-gcm' : 'aes-256-gcm';
  console.log(`🔑 Desencriptando con ${algoritmo} (key: ${aesKey.length} bytes)`);

  const iv = Buffer.from(initialVector, 'base64');
  const decipher = crypto.createDecipheriv(algoritmo, aesKey, iv);

  const encryptedBuffer = Buffer.from(encryptedData, 'base64');
  const tag  = encryptedBuffer.slice(-16);
  const data = encryptedBuffer.slice(0, -16);

  decipher.setAuthTag(tag);
  let decrypted = decipher.update(data, 'binary', 'utf8');
  decrypted += decipher.final('utf8');

  return { flowData: JSON.parse(decrypted), aesKey, iv };
}

// =============================================
// FUNCIÓN: Encriptar respuesta para el Flow
// ✅ CORRECTO: Meta requiere flip de bits en el IV (XOR 0xFF)
//    NO usar .reverse() — invierte orden de bytes, no los bits
// =============================================
function encriptarRespuestaFlow(aesKey, iv, responseData) {
  const algoritmo = aesKey.length === 16 ? 'aes-128-gcm' : 'aes-256-gcm';

  // ✅ Flip de bits en cada byte — requerido por Meta
  const ivInvertido = Buffer.from(iv).map(byte => byte ^ 0xFF);

  const cipher = crypto.createCipheriv(algoritmo, aesKey, ivInvertido);

  const responseStr = JSON.stringify(responseData);
  const encrypted = Buffer.concat([
    cipher.update(responseStr, 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([encrypted, tag]).toString('base64');
}

// =============================================
// MANEJADOR CENTRAL DEL FLOW
// =============================================
async function manejarFlow(body, res) {
  console.log('🔍 manejarFlow — keys recibidas:', Object.keys(body));
  console.log('🔍 manejarFlow — body (300 chars):', JSON.stringify(body).substring(0, 300));

  const { encrypted_aes_key, initial_vector, encrypted_flow_data } = body;

  if (!encrypted_aes_key || !initial_vector || !encrypted_flow_data) {
    console.warn('⚠️ Faltan campos de Flow. Keys presentes:', Object.keys(body));
    return false;
  }

  console.log('🔄 Request de Flow detectado — procesando...');

  if (!PRIVATE_KEY) {
    console.error('❌ Falta PRIVATE_KEY');
    res.status(500).send('Error de configuración');
    return true;
  }

  try {
    const { flowData, aesKey, iv } = desencriptarFlow(
      encrypted_aes_key,
      initial_vector,
      encrypted_flow_data
    );
    console.log('🔄 Flow action:', flowData.action, '| screen:', flowData.screen);
    console.log('🔄 Flow data:', JSON.stringify(flowData.data));

    let responseData;

    // ── PING ──────────────────────────────────────────
    if (flowData.action === 'ping') {
      console.log('🏓 Ping de Meta — respondiendo active');
      responseData = { data: { status: 'active' } };

    // ── INIT ──────────────────────────────────────────
    // Meta abre el flow — enviamos la primera screen
    } else if (flowData.action === 'INIT') {
      console.log('🚀 INIT — enviando INGRESO_SUMINISTRO');
      responseData = {
        screen: 'INGRESO_SUMINISTRO',
        data: {}
      };

    // ── DATA_EXCHANGE ─────────────────────────────────
    // El usuario tocó "Continuar" / "Siguiente" en una screen
    } else if (flowData.action === 'data_exchange') {

      const screen = flowData.screen;
      const data   = flowData.data || {};

      // Viene de INGRESO_SUMINISTRO → va a SELECCION_SERVICIO
      if (screen === 'INGRESO_SUMINISTRO') {
        console.log('📲 data_exchange desde INGRESO_SUMINISTRO — suministro:', data.suministro);
        responseData = {
          screen: 'SELECCION_SERVICIO',
          data: {
            suministro: Number(data.suministro)
          }
        };

      // Viene de SELECCION_SERVICIO → va a DATOS_ADICIONALES
      } else if (screen === 'SELECCION_SERVICIO') {
        console.log('📲 data_exchange desde SELECCION_SERVICIO — servicio:', data.servicio);
        responseData = {
          screen: 'DATOS_ADICIONALES',
          data: {
            suministro: Number(data.suministro),
            servicio:   data.servicio
          }
        };

      // Viene de DATOS_ADICIONALES → va a PANTALLA_CIERRE
      } else if (screen === 'DATOS_ADICIONALES') {
        console.log('📲 data_exchange desde DATOS_ADICIONALES — nombre:', data.nombre);
        responseData = {
          screen: 'PANTALLA_CIERRE',
          data: {
            suministro: Number(data.suministro),
            servicio:   data.servicio,
            nombre:     data.nombre,
            direccion:  data.direccion,
            telefono:   data.telefono  || '',
            mensaje:    data.mensaje   || ''
          }
        };

      } else {
        console.warn('⚠️ data_exchange desde screen desconocida:', screen);
        responseData = { data: { status: 'ok' } };
      }

    // ── FALLBACK ──────────────────────────────────────
    } else {
      console.warn('⚠️ Action no reconocida:', flowData.action);
      responseData = { data: { status: 'ok' } };
    }

    const encryptedResponse = encriptarRespuestaFlow(aesKey, iv, responseData);
    console.log('✅ Respondiendo al Flow con Base64 (primeros 40 chars):', encryptedResponse.substring(0, 40));

    res.set('Content-Type', 'text/plain');
    res.status(200).send(encryptedResponse);
    return true;

  } catch (e) {
    console.error('❌ Error procesando Flow:', e.message, e.stack);
    res.status(500).send('Error procesando Flow');
    return true;
  }
}

// ======================
// ENDPOINTS
// ======================

app.get('/', (req, res) => res.status(200).send('✅ Servidor Cooperativa Activo'));

// Verificación del Webhook (GET)
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ WEBHOOK VERIFICADO por Meta');
    res.status(200).send(challenge);
  } else {
    console.warn(`⚠️ Verificación fallida. Token recibido: "${token}"`);
    res.sendStatus(403);
  }
});

// =============================================
// ENDPOINT DEL FLOW (/flow)
// =============================================
app.post('/flow', async (req, res) => {
  console.log('🔄 POST recibido en /flow');
  console.log('📦 rawBody (primeros 200):', req.rawBody?.substring(0, 200));

  let body = req.body;
  if (!body?.encrypted_aes_key && req.rawBody) {
    try { body = JSON.parse(req.rawBody); } catch (e) { /* ya logueado arriba */ }
  }

  const handled = await manejarFlow(body, res);

  if (!handled) {
    console.warn('⚠️ /flow recibió request no reconocido como Flow — respondiendo 200 vacío');
    res.status(200).send('ok');
  }
});

// =============================================
// ENDPOINT PRINCIPAL DEL WEBHOOK (POST)
// =============================================
app.post('/webhook', async (req, res) => {
  console.log('📬 POST recibido en /webhook:', JSON.stringify(req.body).substring(0, 200));

  let body = req.body;
  if (!body || !Object.keys(body).length) {
    try { body = JSON.parse(req.rawBody); } catch (e) { body = {}; }
  }

  // Detectar si es un request de Flow
  if (body.encrypted_flow_data) {
    console.log('🔄 Request de Flow en /webhook — procesando como Flow...');
    await manejarFlow(body, res);
    return;
  }

  if (body.object !== 'whatsapp_business_account') {
    console.log('ℹ️ Objeto no reconocido:', body.object);
    return res.sendStatus(200);
  }

  // Responder 200 a Meta de inmediato
  res.sendStatus(200);

  try {
    const entry   = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const message = value?.messages?.[0];

    if (!message) {
      console.log('ℹ️ Sin mensajes en el payload (status update)');
      return;
    }

    const waId = message.from;
    console.log(`📨 Tipo de mensaje: "${message.type}" de ${waId}`);

    // === CASO 1: Flow completado (nfm_reply) ===
    if (message.type === 'interactive' && message.interactive?.nfm_reply) {
      const nfm = message.interactive.nfm_reply;

      if (!PRIVATE_KEY) {
        console.error('❌ No se puede desencriptar: falta PRIVATE_KEY');
        return;
      }

      const { flowData } = desencriptarFlow(
        nfm.encrypted_aes_key,
        nfm.initial_vector,
        nfm.response_json
      );
      console.log(`📩 Flow completado por ${waId}:`, JSON.stringify(flowData));

      const idReclamo = await registrarReclamo(flowData, waId);

      if (idReclamo) {
        await enviarMensajeWhatsApp(waId, {
          type: 'text',
          text: {
            body:
              `✅ Tu reclamo fue registrado con el ID: *${idReclamo}*.\n\n` +
              `Si querés, podés compartir tu *ubicación* para que podamos localizar la falla más rápido. 📍`
          }
        });
      } else {
        console.warn('⚠️ No se pudo guardar el reclamo');
      }

    // === CASO 2: Ubicación compartida ===
    } else if (message.type === 'location') {
      const { latitude, longitude } = message.location;
      console.log(`📍 Ubicación recibida de ${waId}: ${latitude}, ${longitude}`);

      const guardado = await guardarUbicacion(waId, latitude, longitude);

      await enviarMensajeWhatsApp(waId, {
        type: 'text',
        text: {
          body: guardado
            ? '📍 Gracias por compartir la ubicación de la falla. Fue registrada en tu reclamo.'
            : '📍 Ubicación recibida, pero no encontramos un reclamo reciente asociado a tu número.'
        }
      });

    // === CASO 3: Cualquier otro mensaje → bienvenida + plantilla ===
    } else {
      console.log(`💬 Mensaje de ${waId} — enviando bienvenida y plantilla`);
      await enviarBienvenidaYPlantilla(waId);
    }

  } catch (e) {
    console.error('❌ Error procesando POST:', e.message, e.stack);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor Cooperativa en puerto ${PORT}`);
});
