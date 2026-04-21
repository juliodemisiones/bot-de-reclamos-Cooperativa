const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
require('dotenv').config();

const app = express();

// =============================================
// 1️⃣ RAW BODY — captura el body crudo
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

// =============================================
// 2️⃣ ARCHIVOS ESTÁTICOS
// =============================================
app.use(express.static(path.join(__dirname, 'public')));

// === CONFIGURACIÓN DE VARIABLES DE ENTORNO ===
const PORT = process.env.PORT || 10000;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PRIVATE_KEY = process.env.PRIVATE_KEY
  ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n')
  : null;
const PHONE_NUMBER_ID = "1049500521582925";

if (!WHATSAPP_ACCESS_TOKEN) console.error('❌ ERROR: Falta WHATSAPP_ACCESS_TOKEN');
if (!VERIFY_TOKEN) console.error('❌ ERROR: Falta VERIFY_TOKEN');
if (!PRIVATE_KEY) console.error('❌ ERROR: Falta PRIVATE_KEY');

// --- CONFIGURACIÓN DE GOOGLE SHEETS ---
let serviceAccountAuth;
try {
  if (!process.env.GOOGLE_KEY_JSON) throw new Error('Falta GOOGLE_KEY_JSON');
  const creds = JSON.parse(process.env.GOOGLE_KEY_JSON);
  serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  console.log('✅ Credenciales Google cargadas');
} catch (e) {
  console.error('❌ ERROR: No se pudieron cargar credenciales Google:', e.message);
}

const SHEET_IDS = {
  ENERGIA: '1jA0FYHcrNS0zaX2dnyIkDf10DQeG6VHa_GA5MYdw0JE',
  TIC: '1j7RXTVGlvs9genTq3SAfoWVGTAO-7mX-B2HAvdUzYVQ'
};

const SHEET_IDS_CONTADOR = {
  ENERGIA: '1NdR7cwTmjK-s47VlpDxXDeqnutn4IRJQk8hbUto7zwI',
  TIC: '1m6pOtzlnPUKvOlEkGK-LmV7PNTH-pzhWb3T93077jQI'
};

// RECORDATORIO: Reemplazar este ID con el real de tu nueva Sheet
const SHEET_ID_EMAILS = 'REEMPLAZAR_CON_ID_DE_TU_NUEVA_SHEET';

// =============================================
// MAPAS EN MEMORIA
// =============================================
const ultimoReclamo = new Map();
const estadoUsuario = new Map();
const datosEmailTemp = new Map();

// =============================================
// FUNCIONES AUXILIARES
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

async function enviarMenuInicial(waId) {
  await enviarMensajeWhatsApp(waId, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text: '👋 Bienvenido/a a la *Cooperativa Luz y Fuerza*.\n\n¿En qué podemos ayudarle?'
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'opcion_reclamo', title: '⚡ Avisar corte o falla' } },
          { type: 'reply', reply: { id: 'opcion_email', title: '📧 Email para factura' } }
        ]
      }
    }
  });
  estadoUsuario.set(waId, 'menu');
}

async function enviarPlantillaReclamo(waId) {
  await enviarMensajeWhatsApp(waId, {
    type: 'text',
    text: {
      body: 'Para dar aviso de corte o falla en alguno de nuestros servicios, complete el registro de reclamo.\n\n📋 Tenga a mano su *número de suministro eléctrico*.'
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

// =============================================
// FLUJO DE EMAIL
// =============================================

async function iniciarFlujoEmail(waId) {
  datosEmailTemp.set(waId, {});
  estadoUsuario.set(waId, 'email_suministro');
  await enviarMensajeWhatsApp(waId, {
    type: 'text',
    text: { body: '📧 *Registro de email para factura electrónica*\n\nPor favor ingresá tu *número de suministro*:' }
  });
}

async function procesarPasoEmail(waId, textoMensaje) {
  const estado = estadoUsuario.get(waId);
  const datos = datosEmailTemp.get(waId) || {};

  if (estado === 'email_suministro') {
    const suministroLimpio = textoMensaje.trim();
    if (!/^\d{3,5}$/.test(suministroLimpio)) {
      await enviarMensajeWhatsApp(waId, {
        type: 'text',
        text: { body: '⚠️ El suministro debe tener entre 3 y 5 dígitos. Reintente:' }
      });
      return;
    }
    datos.suministro = suministroLimpio;
    datosEmailTemp.set(waId, datos);
    estadoUsuario.set(waId, 'email_nombre');
    await enviarMensajeWhatsApp(waId, { type: 'text', text: { body: '👤 ¿Nombre del titular?' } });

  } else if (estado === 'email_nombre') {
    datos.nombre = textoMensaje.trim();
    estadoUsuario.set(waId, 'email_correo');
    await enviarMensajeWhatsApp(waId, { type: 'text', text: { body: '✉️ ¿Cuál es tu correo?' } });

  } else if (estado === 'email_correo') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(textoMensaje.trim())) {
      await enviarMensajeWhatsApp(waId, { type: 'text', text: { body: '⚠️ Correo inválido. Reintente:' } });
      return;
    }
    datos.email = textoMensaje.trim();
    estadoUsuario.set(waId, 'email_servicios');
    await enviarMensajeWhatsApp(waId, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: '¿Tiene otros servicios además de energía?' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'servicios_solo_energia', title: 'Solo energía' } },
            { type: 'reply', reply: { id: 'servicios_mismo_titular', title: 'TV/Internet titular' } },
            { type: 'reply', reply: { id: 'servicios_otro_titular', title: 'TV/Int. otro titular' } }
          ]
        }
      }
    });

  } else if (estado === 'email_titular_tic') {
    datos.titularTic = textoMensaje.trim();
    await finalizarFlujoEmail(waId, 'Internet/TV - otro titular', datos.titularTic);
  }
}

async function procesarBotonServicios(waId, buttonId) {
  const datos = datosEmailTemp.get(waId) || {};
  if (buttonId === 'servicios_solo_energia') {
    await finalizarFlujoEmail(waId, 'Solo energía', null);
  } else if (buttonId === 'servicios_mismo_titular') {
    await finalizarFlujoEmail(waId, 'Internet/TV - mismo titular', null);
  } else if (buttonId === 'servicios_otro_titular') {
    estadoUsuario.set(waId, 'email_titular_tic');
    await enviarMensajeWhatsApp(waId, { type: 'text', text: { body: '👤 Indique el nombre del titular de Internet/TV:' } });
  }
}

async function finalizarFlujoEmail(waId, serviciosExtra, titularTic) {
  const datos = datosEmailTemp.get(waId) || {};
  datos.serviciosExtra = serviciosExtra;
  if (titularTic) datos.titularTic = titularTic;

  await registrarEmail(datos, waId);

  const resumen = `✅ *Registrado correctamente.*\n\n• Suministro: ${datos.suministro}\n• Titular: ${datos.nombre}\n• Email: ${datos.email}\n• Servicios: ${serviciosExtra}`;
  await enviarMensajeWhatsApp(waId, { type: 'text', text: { body: resumen } });

  estadoUsuario.delete(waId);
  datosEmailTemp.delete(waId);
  setTimeout(() => enviarMenuInicial(waId), 1500);
}

// =============================================
// GOOGLE SHEETS LOGIC
// =============================================

async function registrarEmail(datos, waId) {
  try {
    const doc = new GoogleSpreadsheet(SHEET_ID_EMAILS, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['EMAILS'];
    const fechaHora = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
    const accessToken = await serviceAccountAuth.getAccessToken();

    // Insertar fila
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID_EMAILS}:batchUpdate`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ insertDimension: { range: { sheetId: sheet.sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 2 }, inheritFromBefore: false } }]
      })
    });

    const valores = [fechaHora, datos.suministro, datos.nombre, datos.email, datos.serviciosExtra || 'Solo energía', datos.titularTic || '', waId];
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID_EMAILS}/values/'EMAILS'!A2:G2?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${accessToken.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ majorDimension: 'ROWS', values: [valores] })
    });
    return true;
  } catch (e) { console.error('❌ Error Sheets Email:', e.message); return false; }
}

async function registrarReclamo(datos, origen) {
  try {
    let spreadsheetId = '';
    let nombrePestaña = '';
    const servicio = datos.servicio ? datos.servicio.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, "") : '';

    if (['ENERGIA', 'ALUMBRADO'].includes(servicio)) {
      spreadsheetId = SHEET_IDS.ENERGIA;
      nombrePestaña = servicio === 'ENERGIA' ? 'ENERGÍA' : 'ALUMBRADO';
    } else if (['INTERNET', 'TELEVISION', 'TELEFONIA'].includes(servicio)) {
      spreadsheetId = SHEET_IDS.TIC;
      nombrePestaña = servicio === 'TELEVISION' ? 'TELEVISIÓN' : (servicio === 'TELEFONIA' ? 'TELEFONÍA' : 'INTERNET');
    } else return null;

    const doc = new GoogleSpreadsheet(spreadsheetId, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[nombrePestaña];

    const esEnergia = (spreadsheetId === SHEET_IDS.ENERGIA);
    const docContador = new GoogleSpreadsheet(esEnergia ? SHEET_IDS_CONTADOR.ENERGIA : SHEET_IDS_CONTADOR.TIC, serviceAccountAuth);
    await docContador.loadInfo();
    const sheetCont = docContador.sheetsById[Object.keys(docContador.sheetsById)[0]];
    await sheetCont.loadCells('A1');
    const celda = sheetCont.getCell(0, 0);
    const nuevoId = (parseInt(celda.value) || 0) + 1;
    celda.value = nuevoId;
    await sheetCont.saveUpdatedCells();

    const fechaHora = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
    const accessToken = await serviceAccountAuth.getAccessToken();

    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ insertDimension: { range: { sheetId: sheet.sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 2 }, inheritFromBefore: false } }]
      })
    });

    const valores = [nuevoId, 'pendiente', fechaHora, origen, datos.suministro || '', datos.nombre || '', datos.direccion || '', datos.telefono || '', datos.mensaje || datos.descripcion || '', ''];
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/'${nombrePestaña}'!A2:J2?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${accessToken.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ majorDimension: 'ROWS', values: [valores] })
    });

    if (origen !== 'oficina') ultimoReclamo.set(origen, { id: nuevoId, spreadsheetId, nombrePestaña });
    return nuevoId;
  } catch (e) { console.error('❌ Error Reclamo:', e.message); return null; }
}

async function guardarUbicacion(waId, lat, lon) {
  const ref = ultimoReclamo.get(waId);
  if (!ref) return false;
  try {
    const accessToken = await serviceAccountAuth.getAccessToken();
    const doc = new GoogleSpreadsheet(ref.spreadsheetId, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[ref.nombrePestaña];
    const rows = await sheet.getRows();
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i].get('ID')) === String(ref.id)) {
        const fila = i + 2;
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ref.spreadsheetId}/values/'${ref.nombrePestaña}'!J${fila}?valueInputOption=USER_ENTERED`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${accessToken.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ majorDimension: 'ROWS', values: [[`${lat}, ${lon}`]] })
        });
        ultimoReclamo.delete(waId);
        return true;
      }
    }
    return false;
  } catch (e) { return false; }
}

// =============================================
// FLOW ENCRYPTION
// =============================================

function desencriptarFlow(encryptedAesKey, initialVector, encryptedData) {
  const aesKey = crypto.privateDecrypt({ key: PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(encryptedAesKey, 'base64'));
  const iv = Buffer.from(initialVector, 'base64');
  const decipher = crypto.createDecipheriv(aesKey.length === 16 ? 'aes-128-gcm' : 'aes-256-gcm', aesKey, iv);
  const encryptedBuffer = Buffer.from(encryptedData, 'base64');
  decipher.setAuthTag(encryptedBuffer.slice(-16));
  let decrypted = decipher.update(encryptedBuffer.slice(0, -16), 'binary', 'utf8');
  decrypted += decipher.final('utf8');
  return { flowData: JSON.parse(decrypted), aesKey, iv };
}

function encriptarRespuestaFlow(aesKey, iv, responseData) {
  const ivInvertido = Buffer.from(iv).map(byte => byte ^ 0xFF);
  const cipher = crypto.createCipheriv(aesKey.length === 16 ? 'aes-128-gcm' : 'aes-256-gcm', aesKey, ivInvertido);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(responseData), 'utf8'), cipher.final()]);
  return Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64');
}

async function manejarFlow(body, res) {
  const { encrypted_aes_key, initial_vector, encrypted_flow_data } = body;
  if (!encrypted_aes_key || !PRIVATE_KEY) return false;
  try {
    const { flowData, aesKey, iv } = desencriptarFlow(encrypted_aes_key, initial_vector, encrypted_flow_data);
    let responseData = { data: { status: 'ok' } };
    if (flowData.action === 'INIT') responseData = { screen: 'INGRESO_SUMINISTRO', data: {} };
    else if (flowData.action === 'data_exchange') {
       if (flowData.screen === 'INGRESO_SUMINISTRO') responseData = { screen: 'SELECCION_SERVICIO', data: { suministro: Number(flowData.data.suministro) } };
       else if (flowData.screen === 'SELECCION_SERVICIO') responseData = { screen: 'DATOS_ADICIONALES', data: { ...flowData.data } };
       else if (flowData.screen === 'DATOS_ADICIONALES') responseData = { screen: 'PANTALLA_CIERRE', data: { ...flowData.data } };
    }
    res.set('Content-Type', 'text/plain').status(200).send(encriptarRespuestaFlow(aesKey, iv, responseData));
    return true;
  } catch (e) { res.status(500).send('Error'); return true; }
}

// =============================================
// ENDPOINTS
// =============================================

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) res.status(200).send(req.query['hub.challenge']);
  else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  let body = req.body;
  if (body.encrypted_flow_data) { await manejarFlow(body, res); return; }
  res.sendStatus(200);

  try {
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;
    const waId = message.from;
    const estadoActual = estadoUsuario.get(waId);

    // CASO A: Flow completado
    if (message.type === 'interactive' && message.interactive?.nfm_reply) {
      const nfm = message.interactive.nfm_reply;
      let flowData;
      try {
        if (nfm.response_json && !nfm.encrypted_aes_key) flowData = JSON.parse(nfm.response_json);
        else flowData = desencriptarFlow(nfm.encrypted_aes_key, nfm.initial_vector, nfm.response_json).flowData;
        
        const id = await registrarReclamo(flowData, waId);
        if (id) await enviarMensajeWhatsApp(waId, { type: 'text', text: { body: `✅ Registrado ID: *${id}*. Podés compartir tu ubicación 📍` } });
        
        estadoUsuario.delete(waId);
        datosEmailTemp.delete(waId);
      } catch (e) { console.error('Error flow reply'); }

    } // <--- AQUÍ ESTÁ LA LLAVE QUE FALTABA

    // CASO B: Botones interactivos
    else if (message.type === 'interactive' && message.interactive?.button_reply) {
      const bId = message.interactive.button_reply.id;
      if (bId === 'opcion_reclamo') await enviarPlantillaReclamo(waId);
      else if (bId === 'opcion_email') await iniciarFlujoEmail(waId);
      else if (['servicios_solo_energia', 'servicios_mismo_titular', 'servicios_otro_titular'].includes(bId)) await procesarBotonServicios(waId, bId);
      else await enviarMenuInicial(waId);
    }
    // CASO C: Ubicación
    else if (message.type === 'location') {
      const ok = await guardarUbicacion(waId, message.location.latitude, message.location.longitude);
      await enviarMensajeWhatsApp(waId, { type: 'text', text: { body: ok ? '📍 Ubicación guardada.' : '📍 No hay reclamo reciente.' } });
    }
    // CASO D: Texto libre
    else if (message.type === 'text') {
      if (estadoActual && estadoActual.startsWith('email_')) await procesarPasoEmail(waId, message.text.body);
      else await enviarMenuInicial(waId);
    }
  } catch (e) { console.error('Error POST:', e.message); }
});

app.listen(PORT, () => console.log(`🚀 Servidor Cooperativa en puerto ${PORT}`));
