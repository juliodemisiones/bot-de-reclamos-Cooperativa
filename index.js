// === VERSIÓN CORREGIDA - Recomendada ===
const express = require('express');
const crypto = require('crypto');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware CRÍTICO para Meta Flow: debe ser simple y permitir body crudo
app.use(express.json({ limit: '10mb' }));           // JSON normal
app.use(express.text({ type: 'text/plain', limit: '10mb' })); // Por si viene como texto

const PRIVATE_KEY = process.env.PRIVATE_KEY 
  ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') 
  : null;

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = "1049500521582925";

// === CONFIGURACIÓN GOOGLE SHEETS (sin cambios) ===
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
// FUNCIONES (sin cambios importantes)
async function enviarMensajeWhatsApp(to, messageData) { ... }   // mantengo igual

async function enviarBienvenidaYPlantilla(waId) { ... }         // mantengo igual

async function registrarReclamo(datos, waId) { ... }            // mantengo igual

async function guardarUbicacion(waId, latitud, longitud) { ... } // mantengo igual

// ======================
// FUNCIONES DE CRIPTO (mejoradas ligeramente)
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
  const ivInvertido = Buffer.from(iv).reverse();   // ← Meta lo requiere así
  
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
// MANEJADOR DEL FLOW (PRIORIDAD MÁXIMA)
async function manejarFlow(body, res) {
  const { encrypted_aes_key, initial_vector, encrypted_flow_data } = body || {};

  if (!encrypted_aes_key || !initial_vector || !encrypted_flow_data) {
    return false; // No es un payload de Flow
  }

  console.log("🔄 Flow request detectado");

  if (!PRIVATE_KEY) {
    console.error("❌ Falta PRIVATE_KEY");
    return res.status(500).send('Error config');
  }

  try {
    const { flowData, aesKey, iv } = desencriptarFlow(
      encrypted_aes_key, 
      initial_vector, 
      encrypted_flow_data
    );

    console.log("Flow action:", flowData.action, "screen:", flowData.screen);

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
    console.log("✅ Flow respondido correctamente con Base64");
    return true;

  } catch (e) {
    console.error("❌ Error en manejarFlow:", e.message);
    res.status(200).json({ data: { status: "active" } }); // fallback seguro
    return true;
  }
}

// ======================
// ROUTES
// ======================

app.get('/', (req, res) => res.send('✅ Servidor Cooperativa Activo'));

// Webhook Verification (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado por Meta");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ENDPOINT PRINCIPAL - Aquí llega TODO de Meta
app.post('/webhook', async (req, res) => {
  console.log("📬 POST /webhook recibido");

  const body = req.body;

  // === PRIORIDAD 1: Es un request de Flow? ===
  const esFlow = await manejarFlow(body, res);
  if (esFlow) return;   // ← Muy importante: cortamos aquí si era Flow

  // === Si no es Flow, procesamos mensaje normal de WhatsApp ===
  if (body.object !== 'whatsapp_business_account') {
    return res.sendStatus(200);
  }

  res.sendStatus(200); // Respondemos rápido a Meta

  try {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const waId = message.from;

    if (message.type === 'interactive' && message.interactive?.nfm_reply) {
      // Flow completado
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
          text: { body: `✅ Tu reclamo fue registrado con el ID: *${idReclamo}*.\n\nSi querés, compartí tu ubicación 📍` }
        });
      }
    } 
    else if (message.type === 'location') {
      const { latitude, longitude } = message.location;
      await guardarUbicacion(waId, latitude, longitude);
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
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
