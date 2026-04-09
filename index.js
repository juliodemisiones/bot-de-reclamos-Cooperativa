const express = require('express');
const crypto = require('crypto');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
require('dotenv').config();

const app = express();

// =============================================
// 1️⃣ RAW BODY — captura el body crudo en TODAS las rutas
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
if (!VERIFY_TOKEN) console.error('❌ ERROR: Falta VERIFY_TOKEN en Render');
if (!PRIVATE_KEY) console.error('❌ ERROR: Falta PRIVATE_KEY en Render');

// --- CONFIGURACIÓN DE GOOGLE SHEETS ---
let serviceAccountAuth;
try {
  if (!process.env.GOOGLE_KEY_JSON) throw new Error('Falta variable de entorno GOOGLE_KEY_JSON');
  const creds = JSON.parse(process.env.GOOGLE_KEY_JSON);
  serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  console.log('✅ Credenciales Google cargadas desde variable de entorno');
} catch (e) {
  console.error('❌ ERROR: No se pudieron cargar credenciales Google:', e.message);
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
// FUNCIÓN: Registrar reclamo en Google Sheets (MODIFICADA)
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

    // --- ID GLOBAL desde hoja CONTADOR ---
    const docContador = new GoogleSpreadsheet(SHEET_IDS.ENERGIA, serviceAccountAuth);
    await docContador.loadInfo();
    const sheetContador = docContador.sheetsByTitle['CONTADOR'];
    if (!sheetContador) throw new Error('No existe la pestaña CONTADOR en el sheet de ENERGÍA');
    await sheetContador.loadCells('A1');
    const celdaId = sheetContador.getCell(0, 0);
    const nuevoId = (parseInt(celdaId.value) || 0) + 1;
    celdaId.value = nuevoId;
    await sheetContador.saveUpdatedCells();

    const fechaHora = new Date().toLocaleString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires'
    });

    // ==================== NUEVA FORMA: INSERTAR EN FILA 2 ====================
    const nuevaFila = {
      'ID': nuevoId,
      'Estado': 'pendiente',
      'Fecha y Hora': fechaHora,
      'Desde WhatsApp': waId,
      'Suministro': datos.suministro || '',
      'Nombre': datos.nombre || '',
      'Dirección': datos.direccion || '',
      'Teléfono Contacto': datos.telefono || '',
      'Descripción': datos.mensaje || datos.descripcion || '',
      'Marca GPS': ''
    };

    // Insertar en la fila 2 (desplaza todas las anteriores hacia abajo)
    await sheet.insertRow(2, nuevaFila, 'USER_ENTERED');

    console.log(`✅ Reclamo ID ${nuevoId} insertado en la FILA 2 de "${nombrePestaña}"`);
    return nuevoId;

  } catch (error) {
    console.error('❌ Error en Sheets:', error.message, JSON.stringify(error?.response?.data ?? error?.errors ?? error?.toString()));
    return null;
  }
}

// =============================================
// FUNCIÓN: Guardar ubicación en el último reclamo
// =============================================
async function guardarUbicacion(waId, latitud, longitud) {
  const valorGPS = `${latitud}, ${longitud}`;
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
  const tag = encryptedBuffer.slice(-16);
  const data = encryptedBuffer.slice(0, -16);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(data, 'binary', 'utf8');
  decrypted += decipher.final('utf8');
  return { flowData: JSON.parse(decrypted), aesKey, iv };
}

// =============================================
// FUNCIÓN: Encriptar respuesta para el Flow
// =============================================
function encriptarRespuestaFlow(aesKey, iv, responseData) {
  const algoritmo = aesKey.length === 16 ? 'aes-128-gcm' : 'aes-256-gcm';
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
  const { encrypted_aes_key, initial_vector, encrypted_flow_data } = body;
  if (!encrypted_aes_key || !initial_vector || !encrypted_flow_data) {
    console.warn('⚠️ Faltan campos de Flow.');
    return false;
  }

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

    let responseData;

    if (flowData.action === 'ping') {
      responseData = { data: { status: 'active' } };
    } else if (flowData.action === 'INIT') {
      responseData = { screen: 'INGRESO_SUMINISTRO', data: {} };
    } else if (flowData.action === 'data_exchange') {
      const screen = flowData.screen;
      const data = flowData.data || {};

      if (screen === 'INGRESO_SUMINISTRO') {
        responseData = { screen: 'SELECCION_SERVICIO', data: { suministro: Number(data.suministro) } };
      } else if (screen === 'SELECCION_SERVICIO') {
        responseData = { 
          screen: 'DATOS_ADICIONALES', 
          data: { suministro: Number(data.suministro), servicio: data.servicio } 
        };
      } else if (screen === 'DATOS_ADICIONALES') {
        responseData = { 
          screen: 'PANTALLA_CIERRE', 
          data: {
            suministro: Number(data.suministro),
            servicio: data.servicio,
            nombre: data.nombre,
            direccion: data.direccion,
            telefono: data.telefono || '',
            mensaje: data.mensaje || ''
          }
        };
      }
    } else {
      responseData = { data: { status: 'ok' } };
    }

    const encryptedResponse = encriptarRespuestaFlow(aesKey, iv, responseData);
    res.set('Content-Type', 'text/plain');
    res.status(200).send(encryptedResponse);
    return true;

  } catch (e) {
    console.error('❌ Error procesando Flow:', e.message);
    res.status(500).send('Error procesando Flow');
    return true;
  }
}

// ======================
// ENDPOINTS
// ======================
app.get('/', (req, res) => res.status(200).send('✅ Servidor Cooperativa Activo'));

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ WEBHOOK VERIFICADO por Meta');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/flow', async (req, res) => {
  console.log('🔄 POST recibido en /flow');
  let body = req.body;
  if (!body?.encrypted_aes_key && req.rawBody) {
    try { body = JSON.parse(req.rawBody); } catch (e) {}
  }
  const handled = await manejarFlow(body, res);
  if (!handled) res.status(200).send('ok');
});

app.post('/webhook', async (req, res) => {
  let body = req.body;
  if (!body || !Object.keys(body).length) {
    try { body = JSON.parse(req.rawBody); } catch (e) { body = {}; }
  }

  if (body.encrypted_flow_data) {
    await manejarFlow(body, res);
    return;
  }

  if (body.object !== 'whatsapp_business_account') {
    return res.sendStatus(200);
  }

  res.sendStatus(200);

  try {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const waId = message.from;

    if (message.type === 'interactive' && message.interactive?.nfm_reply) {
      const nfm = message.interactive.nfm_reply;
      let flowData;

      if (nfm.response_json && !nfm.encrypted_aes_key) {
        flowData = JSON.parse(nfm.response_json);
      } else if (PRIVATE_KEY) {
        const result = desencriptarFlow(nfm.encrypted_aes_key, nfm.initial_vector, nfm.response_json);
        flowData = result.flowData;
      }

      const idReclamo = await registrarReclamo(flowData, waId);

      if (idReclamo) {
        await enviarMensajeWhatsApp(waId, {
          type: 'text',
          text: {
            body: `✅ Tu reclamo fue registrado con el ID: *${idReclamo}*.\n\nSi querés, podés compartir tu *ubicación* para que podamos localizar la falla más rápido. 📍`
          }
        });
      }
    } else if (message.type === 'location') {
      const { latitude, longitude } = message.location;
      const guardado = await guardarUbicacion(waId, latitude, longitude);
      await enviarMensajeWhatsApp(waId, {
        type: 'text',
        text: {
          body: guardado 
            ? '📍 Gracias por compartir la ubicación de la falla. Fue registrada en tu reclamo.' 
            : '📍 Ubicación recibida, pero no encontramos un reclamo reciente asociado a tu número.'
        }
      });
    } else {
      await enviarBienvenidaYPlantilla(waId);
    }
  } catch (e) {
    console.error('❌ Error procesando POST:', e.message);
  }
});

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
          parameters: [{ type: 'action', action: { flow_token: `${waId}_${Date.now()}` } }]
        }
      ]
    }
  });
}

app.listen(PORT, () => {
  console.log(`🚀 Servidor Cooperativa en puerto ${PORT}`);
});
