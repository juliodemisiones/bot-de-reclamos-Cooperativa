const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
require('dotenv').config();
const { iniciarBaileys, enviarAlGrupoTIC } = require('./baileys-sender');
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
const PHONE_NUMBER_ID = "1130637376793846";

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

// Sheets de reclamos (por servicio)
const SHEET_IDS = {
  ENERGIA: '1jA0FYHcrNS0zaX2dnyIkDf10DQeG6VHa_GA5MYdw0JE',
  TIC: '1j7RXTVGlvs9genTq3SAfoWVGTAO-7mX-B2HAvdUzYVQ'
};

// Sheets de contadores de ID por sector
const SHEET_IDS_CONTADOR = {
  ENERGIA: '1NdR7cwTmjK-s47VlpDxXDeqnutn4IRJQk8hbUto7zwI',
  TIC: '1m6pOtzlnPUKvOlEkGK-LmV7PNTH-pzhWb3T93077jQI'
};

// ⚠️ REEMPLAZÁ este ID con el de tu nueva Google Sheet para emails de factura
// La hoja debe tener una pestaña llamada "EMAILS" con encabezados:
// A=Fecha | B=Suministro | C=Titular energía | D=Email | E=Servicios Extra | F=Titular Internet/TV | G=Teléfono WA
const SHEET_ID_EMAILS = '1NDks8ANxSBQMKryuKl_lUGtJPIf5kfyiKWt-KARUNic';

// =============================================
// MAPAS EN MEMORIA
// =============================================

// waId → última referencia de reclamo (para guardar ubicación)
const ultimoReclamo = new Map();
const ubicacionesTemporales = new Map();

// waId → estado del flujo de email
// Valores posibles: 'menu' | 'email_suministro' | 'email_nombre' | 'email_correo' | 'email_servicios'
const estadoUsuario = new Map();

// waId → datos parciales del flujo de email
const datosEmailTemp = new Map();

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
// FUNCIÓN: Menú inicial con dos opciones (botones)
// =============================================
async function enviarMenuInicial(waId) {
  await enviarMensajeWhatsApp(waId, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text:
          '👋 Bienvenido/a a la *Cooperativa Luz y Fuerza*.\n\n' +
          '¿En qué podemos ayudarle?'
      },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: {
              id: 'opcion_reclamo',
              title: '⚡Avisar corte/falla'
            }
          },
          {
            type: 'reply',
            reply: {
              id: 'opcion_email',
              title: '📧Registrar Email'
            }
          }
        ]
      }
    }
  });
  estadoUsuario.set(waId, 'menu');
}

// =============================================
// FUNCIÓN: Enviar plantilla de reclamo (Flow)
// =============================================
async function enviarPlantillaReclamo(waId) {
  await enviarMensajeWhatsApp(waId, {
    type: 'text',
    text: {
      body:
        'Para dar aviso de corte o falla en alguno de nuestros servicios, ' +
        'a continuación complete el registro de reclamo.\n\n' +
        '📋 Tenga a mano su *número de suministro eléctrico* (es un dato necesario),\n' + 
        'incluso si su reclamo es de Internet o TV.\n\n' +
        'Para consultas administrativas comuníquese al fijo *476000* de lunes a viernes de 6:30 a 13 hs.'
    }
  });

  await enviarMensajeWhatsApp(waId, {
    type: 'template',
    template: {
      name: 'plantilla_v4',
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
// FLUJO DE REGISTRO DE EMAIL — paso a paso
// =============================================

async function iniciarFlujoEmail(waId) {
  datosEmailTemp.set(waId, {});
  estadoUsuario.set(waId, 'email_suministro');
  await enviarMensajeWhatsApp(waId, {
    type: 'text',
    text: {
      body:
        '📧 *Registro de email para factura electrónica*\n\n' +
        'Por favor ingresá tu *número de suministro*:'
    }
  });
}

async function procesarPasoEmail(waId, textoMensaje) {
  const estado = estadoUsuario.get(waId);
  const datos = datosEmailTemp.get(waId) || {};

  if (estado === 'email_suministro') {
    const suministroLimpio = textoMensaje.trim();
    const suministroRegex = /^\d{3,5}$/;
    if (!suministroRegex.test(suministroLimpio)) {
      await enviarMensajeWhatsApp(waId, {
        type: 'text',
        text: {
          body: '⚠️ El número de suministro debe contener entre 3 y 5 dígitos numéricos (por ejemplo: 1234). Por favor ingresalo nuevamente:'
        }
      });
      return;
    }
    datos.suministro = suministroLimpio;
    datosEmailTemp.set(waId, datos);
    estadoUsuario.set(waId, 'email_nombre');
    await enviarMensajeWhatsApp(waId, {
      type: 'text',
      text: { body: '👤 ¿Cuál es el *nombre del titular* del servicio?' }
    });

  } else if (estado === 'email_nombre') {
    datos.nombre = textoMensaje.trim();
    datosEmailTemp.set(waId, datos);
    estadoUsuario.set(waId, 'email_correo');
    await enviarMensajeWhatsApp(waId, {
      type: 'text',
      text: { body: '✉️ ¿Cuál es tu *correo electrónico*?' }
    });

  } else if (estado === 'email_correo') {
    // Validación básica de email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(textoMensaje.trim())) {
      await enviarMensajeWhatsApp(waId, {
        type: 'text',
        text: {
          body: '⚠️ El correo ingresado no parece válido. Por favor ingresá una dirección de email correcta (ejemplo: nombre@gmail.com):'
        }
      });
      return;
    }
    datos.email = textoMensaje.trim();
    datosEmailTemp.set(waId, datos);
    estadoUsuario.set(waId, 'email_servicios');
    await enviarMensajeWhatsApp(waId, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: '¿Además del servicio de energía, tiene otros servicios? Por favor seleccione:'
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'servicios_solo_energia', title: 'Solo energía' } },
            { type: 'reply', reply: { id: 'servicios_mismo_titular', title: 'TV/Int.mismo titular' } },
            { type: 'reply', reply: { id: 'servicios_otro_titular', title: 'TV/Int. otro titular' } }
          ]
        }
      }
    });

  } else if (estado === 'email_servicios_solo_energia') {
    // Por si el usuario escribe texto libre en este estado
    await finalizarFlujoEmail(waId, 'Solo energía', null);
  } else if (estado === 'email_titular_tic') {
    // Captura del nombre del titular de internet/TV (otro titular)
    datos.titularTic = textoMensaje.trim();
    datosEmailTemp.set(waId, datos);
    await finalizarFlujoEmail(waId, 'Internet/TV - otro titular', datos.titularTic);
}
}
async function procesarBotonServicios(waId, buttonId) {
  const datos = datosEmailTemp.get(waId) || {};

  if (buttonId === 'servicios_solo_energia') {
    datos.serviciosExtra = 'Solo energía';
    datosEmailTemp.set(waId, datos);
    await finalizarFlujoEmail(waId, 'Solo energía', null);

  } else if (buttonId === 'servicios_mismo_titular') {
    datos.serviciosExtra = 'Internet/TV - mismo titular';
    datosEmailTemp.set(waId, datos);
    await finalizarFlujoEmail(waId, 'Internet/TV - mismo titular', null);

  } else if (buttonId === 'servicios_otro_titular') {
    datos.serviciosExtra = 'Internet/TV - otro titular';
    datosEmailTemp.set(waId, datos);
    estadoUsuario.set(waId, 'email_titular_tic');
    await enviarMensajeWhatsApp(waId, {
      type: 'text',
      text: { body: '👤 Indique el *nombre del titular* de Internet/TV:' }
    });
  }
}

async function finalizarFlujoEmail(waId, serviciosExtra, titularTic) {
  const datos = datosEmailTemp.get(waId) || {};
  datos.serviciosExtra = serviciosExtra;
  if (titularTic) datos.titularTic = titularTic;

  // Guardar en Google Sheets
  const guardado = await registrarEmail(datos, waId);

  // Armar texto del resumen
  let textoServicios = serviciosExtra || 'Solo energía';

  let lineaTitularTic = '';
  if (titularTic) {
    lineaTitularTic = `• Titular Internet/TV: *${titularTic}*\n`;
  }

  const resumen =
    `✅ *¡Listo! Registramos tu email correctamente.*\n\n` +
    `📋 *Resumen:*\n` +
    `• Suministro: *${datos.suministro}*\n` +
    `• Titular energía: *${datos.nombre}*\n` +
    `• Email: *${datos.email}*\n` +
    `• Servicios: *${textoServicios}*\n` +
    lineaTitularTic +
    `\n📬 Recibirá la próxima factura en su correo electrónico.\n\n` +
    `_Si tiene varias conexiones, por favor repita los pasos para adherir cada una._`;

  await enviarMensajeWhatsApp(waId, {
    type: 'text',
    text: { body: resumen }
  });

  if (!guardado) {
    console.warn(`⚠️ No se pudo guardar el email de ${waId} en Sheets`);
  }

  // Limpiar estado
  estadoUsuario.delete(waId);
  datosEmailTemp.delete(waId);

  // Volver al menú inicial después de un momento
  await new Promise(resolve => setTimeout(resolve, 1500));
  await enviarMenuInicial(waId);
}

// =============================================
// FUNCIÓN: Registrar email en Google Sheets
// =============================================
async function registrarEmail(datos, waId) {
  try {
    const doc = new GoogleSpreadsheet(SHEET_ID_EMAILS, serviceAccountAuth);
    await doc.loadInfo();

    // Buscamos la pestaña "EMAILS"
    const sheet = doc.sheetsByTitle['EMAILS'];
    if (!sheet) throw new Error('No existe la pestaña "EMAILS" en la hoja de emails');

    const fechaHora = new Date().toLocaleString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires'
    });

    const accessToken = await serviceAccountAuth.getAccessToken();

    // Insertar fila vacía en índice 1 (después del encabezado)
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID_EMAILS}:batchUpdate`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          requests: [{
            insertDimension: {
              range: {
                sheetId: sheet.sheetId,
                dimension: 'ROWS',
                startIndex: 1,
                endIndex: 2
              },
              inheritFromBefore: false
            }
          }]
        })
      }
    );

    // Escribir datos en la fila 2
    // Columnas: A=Fecha | B=Suministro | C=Titular energía | D=Email | E=Servicios Extra | F=Titular Internet/TV | G=Teléfono WA
    const valores = [
      fechaHora,
      datos.suministro || '',
      datos.nombre || '',
      datos.email || '',
      datos.serviciosExtra || 'Solo energía',
      datos.titularTic || '',
      waId
    ];

    const rangeEncoded = encodeURIComponent(`'EMAILS'!A2:G2`);
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID_EMAILS}/values/${rangeEncoded}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          majorDimension: 'ROWS',
          values: [valores]
        })
      }
    );

    console.log(`✅ Email registrado para suministro ${datos.suministro} (${waId})`);
    return true;

  } catch (error) {
    console.error('❌ Error guardando email en Sheets:', error.message);
    return false;
  }
}

// =============================================
// FUNCIÓN: Registrar reclamo en Google Sheets
// =============================================
async function registrarReclamo(datos, origen) {
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

    const esEnergía = (servicio === 'ENERGIA' || servicio === 'ALUMBRADO');
    const sheetIdContador = esEnergía
      ? SHEET_IDS_CONTADOR.ENERGIA
      : SHEET_IDS_CONTADOR.TIC;

    const docContador = new GoogleSpreadsheet(sheetIdContador, serviceAccountAuth);
    await docContador.loadInfo();
    const sheetContador = docContador.sheetsById[Object.keys(docContador.sheetsById)[0]];
    await sheetContador.loadCells('A1');
    const celdaId = sheetContador.getCell(0, 0);
    const nuevoId = (parseInt(celdaId.value) || 0) + 1;
    celdaId.value = nuevoId;
    await sheetContador.saveUpdatedCells();

    const fechaHora = new Date().toLocaleString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires'
    });

    const sheetId = sheet.sheetId;
    const accessToken = await serviceAccountAuth.getAccessToken();

    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          requests: [{
            insertDimension: {
              range: {
                sheetId: sheetId,
                dimension: 'ROWS',
                startIndex: 1,
                endIndex: 2
              },
              inheritFromBefore: false
            }
          }]
        })
      }
    );

    const valores = [
      nuevoId,
      'pendiente',
      fechaHora,
      origen,
      datos.suministro || '',
      datos.nombre || '',
      datos.direccion || '',
      datos.telefono || '',
      datos.mensaje || datos.descripcion || '',
      datos.gps || ''
    ];

    const rangeEncoded = encodeURIComponent(`'${nombrePestaña}'!A2:J2`);
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${rangeEncoded}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          majorDimension: 'ROWS',
          values: [valores]
        })
      }
    );

    if (origen !== 'oficina') {
      ultimoReclamo.set(origen, { id: nuevoId, spreadsheetId, nombrePestaña });
    }

    console.log(`✅ Reclamo ID ${nuevoId} guardado en pestaña "${nombrePestaña}" — origen: ${origen}`);
    return nuevoId;

  } catch (error) {
    console.error('❌ Error en Sheets:', error.message, JSON.stringify(error?.response?.data ?? error?.errors ?? error?.toString()));
    return null;
  }
}

// =============================================
// FUNCIÓN: Guardar ubicación en el reclamo exacto
// =============================================
async function guardarUbicacion(waId, latitud, longitud) {
  const valorGPS = `${latitud}, ${longitud}`;
  const accessToken = await serviceAccountAuth.getAccessToken();

  const ref = ultimoReclamo.get(waId);
  if (!ref) {
    console.warn(`⚠️ No hay reclamo reciente en memoria para ${waId}`);
    return false;
  }

  const { id, spreadsheetId, nombrePestaña } = ref;

  try {
    const doc = new GoogleSpreadsheet(spreadsheetId, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[nombrePestaña];
    if (!sheet) throw new Error(`No existe la pestaña "${nombrePestaña}"`);

    const rows = await sheet.getRows();

    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i].get('ID')) === String(id)) {
        const filaReal = i + 2;
        const rangeEncoded = encodeURIComponent(`'${nombrePestaña}'!J${filaReal}`);
        await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${rangeEncoded}?valueInputOption=USER_ENTERED`,
          {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${accessToken.token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              majorDimension: 'ROWS',
              values: [[valorGPS]]
            })
          }
        );
        console.log(`✅ Ubicación guardada para ${waId} (ID ${id}) en hoja "${nombrePestaña}" fila ${filaReal}`);
        ultimoReclamo.delete(waId);
        return true;
      }
    }

    console.warn(`⚠️ No se encontró fila con ID ${id} en "${nombrePestaña}"`);
    return false;

  } catch (e) {
    console.error(`❌ Error guardando ubicación:`, e.message);
    return false;
  }
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
  const { encrypted_aes_key, initial_vector, encrypted_flow_data } = body;

  if (!encrypted_aes_key || !initial_vector || !encrypted_flow_data) {
    return false;
  }

  if (!PRIVATE_KEY) {
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

    let responseData;

    if (flowData.action === 'ping') {
      responseData = { data: { status: 'active' } };
    } else if (flowData.action === 'INIT') {
      responseData = { screen: 'INGRESO_SUMINISTRO', data: {} };
    } else if (flowData.action === 'data_exchange') {
      const screen = flowData.screen;
      const data = flowData.data || {};

      if (screen === 'INGRESO_SUMINISTRO') {
        responseData = {
          screen: 'SELECCION_SERVICIO',
          data: { suministro: Number(data.suministro) }
        };
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
      } else {
        responseData = { data: { status: 'ok' } };
      }
    } else {
      responseData = { data: { status: 'ok' } };
    }

    const encryptedResponse = encriptarRespuestaFlow(aesKey, iv, responseData);
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

app.get('/health', (req, res) => res.status(200).send('✅ Servidor Cooperativa Activo'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Verificación del Webhook (GET)
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

// =============================================
// ENDPOINT DEL FLOW (/flow)
// =============================================
app.post('/flow', async (req, res) => {
  let body = req.body;
  if (!body?.encrypted_aes_key && req.rawBody) {
    try { body = JSON.parse(req.rawBody); } catch (e) { }
  }
  const handled = await manejarFlow(body, res);
  if (!handled) {
    res.status(200).send('ok');
  }
});

// =============================================
// ENDPOINT FORMULARIO WEB (/reclamo-web)
// =============================================
app.post('/reclamo-web', async (req, res) => {
  const datos = req.body;
  const camposRequeridos = ['servicio', 'suministro', 'nombre', 'direccion', 'descripcion'];
  const faltantes = camposRequeridos.filter(c => !datos[c] || String(datos[c]).trim() === '');

  if (faltantes.length > 0) {
    return res.status(400).json({
      ok: false,
      error: `Faltan campos obligatorios: ${faltantes.join(', ')}`
    });
  }

  if (datos.descripcion && !datos.mensaje) {
    datos.mensaje = datos.descripcion;
  }

  const idReclamo = await registrarReclamo(datos, 'oficina');

  if (idReclamo) {
    return res.status(200).json({ ok: true, id: idReclamo });
  } else {
    return res.status(500).json({ ok: false, error: 'Error al guardar en Google Sheets' });
  }
});

// =============================================
// ENDPOINT PRINCIPAL DEL WEBHOOK (POST)
// =============================================
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
    const estadoActual = estadoUsuario.get(waId);

    console.log(`📨 Tipo: "${message.type}" | Estado: "${estadoActual}" | De: ${waId}`);

    // ============================================================
    // CASO A: Flow completado (reclamo de servicio)
    // ============================================================
    if (message.type === 'interactive' && message.interactive?.nfm_reply) {
      const nfm = message.interactive.nfm_reply;
      let flowData;

      if (nfm.response_json && !nfm.encrypted_aes_key) {
        try {
          flowData = JSON.parse(nfm.response_json);
        } catch (e) {
          console.error('❌ Error parseando response_json:', e.message);
          return;
        }
      } else {
        if (!PRIVATE_KEY) return;
        try {
          const result = desencriptarFlow(nfm.encrypted_aes_key, nfm.initial_vector, nfm.response_json);
          flowData = result.flowData;
        } catch (e) {
          console.error('❌ Error desencriptando nfm_reply:', e.message);
          return;
        }
      }

const idReclamo = await registrarReclamo(flowData, waId);
if (idReclamo) {
  enviarAlGrupoTIC(flowData, idReclamo, waId, (id) => {
    const ubicacion = ubicacionesTemporales.get(id);
    ubicacionesTemporales.delete(id);
    return ubicacion;
  });

  const serviciosNormalizados = ['internet', 'television', 'telefonia'];
  const servicioNorm = (flowData.servicio || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const esTIC = serviciosNormalizados.includes(servicioNorm);

  const mensajeConfirmacion = esTIC
    ? `✅ Tu reclamo fue registrado correctamente.\n\n` +
      `Si querés, podés compartir tu \*ubicación\* para que podamos localizar la falla más rápido. 📍`
    : `✅ Tu reclamo fue registrado con el ID: \*${idReclamo}\*.\n\n` +
      `Si querés, podés compartir tu \*ubicación\* para que podamos localizar la falla más rápido. 📍`;

  await enviarMensajeWhatsApp(waId, {
    type: 'text',
    text: { body: mensajeConfirmacion }
  });
}
      // Limpiar estado de email por si había algo pendiente
      estadoUsuario.delete(waId);
      datosEmailTemp.delete(waId);

    // ============================================================
    // CASO B: Respuesta a botón interactivo (reply button)
    // ============================================================
    } else if (message.type === 'interactive' && message.interactive?.button_reply) {
      const buttonId = message.interactive.button_reply.id;
      console.log(`🔘 Botón presionado: "${buttonId}" | Estado: "${estadoActual}"`);

      if (buttonId === 'opcion_reclamo') {
        // Limpiar cualquier flujo de email en curso
        estadoUsuario.delete(waId);
        datosEmailTemp.delete(waId);
        await enviarPlantillaReclamo(waId);

      } else if (buttonId === 'opcion_email') {
        await iniciarFlujoEmail(waId);

      } else if (
        ['servicios_solo_energia', 'servicios_mismo_titular', 'servicios_otro_titular'].includes(buttonId)
        && estadoActual === 'email_servicios'
      ) {
        await procesarBotonServicios(waId, buttonId);

      } else {
        // Botón no reconocido en el estado actual → volver al menú
        await enviarMenuInicial(waId);
      }

    // ============================================================
    // CASO C: Ubicación compartida
    // ============================================================
    } else if (message.type === 'location') {
      const { latitude, longitude } = message.location;
      console.log(`📍 Ubicación recibida de ${waId}: ${latitude}, ${longitude}`);

      ubicacionesTemporales.set(waId, `https://maps.google.com/?q=${latitude},${longitude}`);
const guardado = await guardarUbicacion(waId, latitude, longitude);

      await enviarMensajeWhatsApp(waId, {
        type: 'text',
        text: {
          body: guardado
            ? '📍 Gracias por compartir la ubicación de la falla. Fue registrada en tu reclamo.'
            : '📍 Ubicación recibida, pero no encontramos un reclamo reciente asociado a tu número.'
        }
      });

    // ============================================================
    // CASO D: Mensaje de texto libre
    // ============================================================
    } else if (message.type === 'text') {
      const texto = message.text?.body || '';

      // Si el usuario está en algún paso del flujo de email → procesar
      if (
        estadoActual === 'email_suministro' ||
        estadoActual === 'email_nombre' ||
        estadoActual === 'email_correo' ||
        estadoActual === 'email_titular_tic'
      ) {
        await procesarPasoEmail(waId, texto);

      } else {
        // Cualquier otro texto → menú inicial
        await enviarMenuInicial(waId);
      }

    // ============================================================
    // CASO E: Cualquier otro tipo de mensaje → menú inicial
    // ============================================================
    } else {
      await enviarMenuInicial(waId);
    }

  } catch (e) {
    console.error('❌ Error procesando POST:', e.message, e.stack);
  }
});
// =============================================
// ENDPOINT: GET /reclamos?sector=ENERGIA|ALUMBRADO
// Devuelve todas las filas de la pestaña correspondiente
// con su rowIndex para poder actualizar el estado.
// =============================================
app.get('/reclamos', async (req, res) => {
  const sector = (req.query.sector || '').toUpperCase();

  if (!['ENERGIA', 'ALUMBRADO'].includes(sector)) {
    return res.status(400).json({ ok: false, error: 'Sector inválido. Usar ENERGIA o ALUMBRADO' });
  }

  const spreadsheetId = SHEET_IDS.ENERGIA; // Ambos están en el mismo sheet
  const nombrePestaña = sector === 'ENERGIA' ? 'ENERGÍA' : 'ALUMBRADO';

  try {
    const doc = new GoogleSpreadsheet(spreadsheetId, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[nombrePestaña];
    if (!sheet) throw new Error(`No existe la pestaña "${nombrePestaña}"`);

    const rows = await sheet.getRows();

    const reclamos = rows.map((row, i) => ({
      rowIndex:    i + 2, // fila real en la sheet (1 = encabezado, 2 = primera fila de datos)
      id:          row.get('ID')          || '',
      estado:      row.get('Estado')      || 'pendiente',
      fecha:       row.get('Fecha')       || '',
      origen:      row.get('Origen')      || '',
      suministro:  row.get('Suministro')  || '',
      nombre:      row.get('Nombre')      || '',
      direccion:   row.get('Dirección')   || '',
      telefono:    row.get('Teléfono')    || '',
      descripcion: row.get('Descripción') || '',
      gps:         row.get('GPS')         || '',
    }));

    console.log(`📋 GET /reclamos — sector ${sector}: ${reclamos.length} filas devueltas`);
    return res.status(200).json({ ok: true, sector, reclamos });

  } catch (error) {
    console.error('❌ Error leyendo reclamos:', error.message);
    return res.status(500).json({ ok: false, error: 'Error leyendo Google Sheets' });
  }
});

// =============================================
// ENDPOINT: GET /reclamos?sector=ENERGIA|ALUMBRADO
// Devuelve todas las filas con los nombres de columna
// exactos de la Google Sheet.
// =============================================
app.get('/reclamos', async (req, res) => {
  const sector = (req.query.sector || '').toUpperCase();

  if (!['ENERGIA', 'ALUMBRADO'].includes(sector)) {
    return res.status(400).json({ ok: false, error: 'Sector inválido. Usar ENERGIA o ALUMBRADO' });
  }

  const spreadsheetId = SHEET_IDS.ENERGIA; // Ambas pestañas están en el mismo sheet
  const nombrePestaña = sector === 'ENERGIA' ? 'ENERGÍA' : 'ALUMBRADO';

  try {
    const doc = new GoogleSpreadsheet(spreadsheetId, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[nombrePestaña];
    if (!sheet) throw new Error(`No existe la pestaña "${nombrePestaña}"`);

    const rows = await sheet.getRows();

    const reclamos = rows.map((row, i) => ({
      rowIndex:       i + 2,                          // fila real (1 = encabezado)
      id:             row.get('ID')                  || '',
      estado:         row.get('Estado')              || 'pendiente',
      fechaHora:      row.get('Fecha y Hora')        || '',
      desdeWhatsapp:  row.get('Desde WhatsApp')      || '',
      suministro:     row.get('Suministro')          || '',
      nombre:         row.get('Nombre')              || '',
      direccion:      row.get('Dirección')           || '',
      telefonoContacto: row.get('Teléfono Contacto') || '',
      descripcion:    row.get('Descripción')         || '',
      marcaGPS:       row.get('Marca GPS')           || '',
    }));

    console.log(`📋 GET /reclamos — ${sector}: ${reclamos.length} filas`);
    return res.status(200).json({ ok: true, sector, reclamos });

  } catch (error) {
    console.error('❌ Error leyendo reclamos:', error.message);
    return res.status(500).json({ ok: false, error: 'Error leyendo Google Sheets' });
  }
});

// =============================================
// ENDPOINT: PATCH /reclamos/estado
// Cambia la celda B(rowIndex) al nuevo estado.
// Body JSON: { sector, rowIndex, estado }
// =============================================
app.patch('/reclamos/estado', async (req, res) => {
  const { sector, rowIndex, estado } = req.body;

  const estadosValidos = ['pendiente', 'atendido', 'derivado'];
  if (!sector || !rowIndex || !estado) {
    return res.status(400).json({ ok: false, error: 'Faltan campos: sector, rowIndex, estado' });
  }
  if (!estadosValidos.includes(estado.toLowerCase())) {
    return res.status(400).json({ ok: false, error: `Estado inválido. Usar: ${estadosValidos.join(', ')}` });
  }

  const sectorNorm = sector.toUpperCase();
  if (!['ENERGIA', 'ALUMBRADO'].includes(sectorNorm)) {
    return res.status(400).json({ ok: false, error: 'Sector inválido. Usar ENERGIA o ALUMBRADO' });
  }

  const spreadsheetId = SHEET_IDS.ENERGIA;
  const nombrePestaña = sectorNorm === 'ENERGIA' ? 'ENERGÍA' : 'ALUMBRADO';

  try {
    const accessToken = await serviceAccountAuth.getAccessToken();
    const rangeEncoded = encodeURIComponent(`'${nombrePestaña}'!B${rowIndex}`);

    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${rangeEncoded}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          majorDimension: 'ROWS',
          values: [[estado.toLowerCase()]]
        })
      }
    );

    if (!response.ok) {
      const errData = await response.json();
      console.error('❌ Error actualizando estado en Sheets:', JSON.stringify(errData));
      return res.status(500).json({ ok: false, error: 'Error al escribir en Google Sheets' });
    }

    console.log(`✅ PATCH /reclamos/estado — "${nombrePestaña}" fila ${rowIndex} → "${estado}"`);
    return res.status(200).json({ ok: true, rowIndex, estado });

  } catch (error) {
    console.error('❌ Error en PATCH /reclamos/estado:', error.message);
    return res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});
app.listen(PORT, () => {
  console.log(`🚀 Servidor Cooperativa en puerto ${PORT}`);
  iniciarBaileys().catch(e => console.error('❌ [Baileys] Error al iniciar:', e.message));
});
