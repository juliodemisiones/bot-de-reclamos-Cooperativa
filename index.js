// === VERSIÓN CORREGIDA - TODO por /webhook (recomendada) ===
const express = require('express');
const crypto = require('crypto');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: 'text/plain', limit: '10mb' }));

const PRIVATE_KEY = process.env.PRIVATE_KEY 
  ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') 
  : null;

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = "1049500521582925";

// Configuración Google Sheets (igual)
let serviceAccountAuth;
try {
  const creds = require('./google-key.json');
  serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  console.log("✅ google-key.json cargado");
} catch (e) {
  console.error("❌ google-key.json:", e.message);
}

const SHEET_IDS = {
  ENERGIA: '1jA0FYHcrNS0zaX2dnyIkDf10DQeG6VHa_GA5MYdw0JE',
  TIC: '1j7RXTVGlvs9genTq3SAfoWVGTAO-7mX-B2HAvdUzYVQ'
};

// ======================
// FUNCIONES (mantengo igual)
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
      console.error("❌ Error WhatsApp:", JSON.stringify(result));
      return false;
    }
    console.log(`✅ Mensaje enviado a ${to}`);
    return true;
  } catch (error) {
    console.error("❌ Fetch WhatsApp:", error.message);
    return false;
  }
}

async function enviarBienvenidaYPlantilla(waId) {
  await enviarMensajeWhatsApp(waId, {
    type: "text",
    text: { body: "Se ha comunicado con la Cooperativa Luz y Fuerza.\n\nPara dar aviso de corte o falla...\n\n📋 Tenga a mano su *número de suministro eléctrico*...\n\nPara consultas: *476000*" }
  });

  await enviarMensajeWhatsApp(waId, {
    type: "template",
    template: {
      name: "reclamos_v2",
      language: { code: "es_AR" },
      components: [{
        type: "button",
        sub_type: "flow",
        index: "0",
        parameters: [{ type: "action", action: { flow_token: `${waId}_${Date.now()}` }}]
      }]
    }
  });
}

// registrarReclamo, guardarUbicacion, desencriptarFlow, encriptarRespuestaFlow 
// (mantengo exactamente las mismas que te di antes - no las repito por brevedad, cópialas del mensaje anterior)

async function registrarReclamo(datos, waId) { /* ... misma función ... */ }
async function guardarUbicacion(waId, latitud, longitud) { /* ... misma ... */ }

function desencriptarFlow(encryptedAesKey, initialVector, encryptedData) { /* misma ... */ }
function encriptarRespuestaFlow(aesKey, iv, responseData) { /* misma ... */ }

// ======================
// MANEJADOR DEL FLOW
async function manejarFlow(body, res) {
  if (!body || !body.encrypted_aes_key || !body.initial_vector || !body.encrypted_flow_data) {
    return false;
  }

  console.log("🔄 Flow detectado - action:", body.action || "desconocido");

  if (!PRIVATE_KEY) {
    res.status(500).send('Error config');
    return true;
  }

  try {
    const { flowData, aesKey, iv } = desencriptarFlow(
      body.encrypted_aes_key, body.initial_vector, body.encrypted_flow_data
    );

    let responseData = { data: { status: "active" } };

    if (flowData.action === 'INIT') {
      responseData = { screen: "INGRESO_SUMINISTRO", data: {} };
    } else if (flowData.action === 'data_exchange') {
      responseData = { screen: flowData.screen, data: flowData.data || {} };
    }

    const encryptedResponse = encriptarRespuestaFlow(aesKey, iv, responseData);

    res.set('Content-Type', 'text/plain');
    res.status(200).send(encryptedResponse);
    console.log("✅ Flow respondido con Base64");
    return true;
  } catch (e) {
    console.error("❌ Error Flow:", e.message);
    res.status(200).json({ data: { status: "active" } });
    return true;
  }
}

// ======================
// ROUTES
app.get('/', (req, res) => res.send('✅ Servidor Activo'));

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;

  // Prioridad 1: ¿Es payload de Flow?
  if (await manejarFlow(body, res)) return;

  // Procesamiento normal de mensajes
  if (body.object !== 'whatsapp_business_account') {
    return res.sendStatus(200);
  }

  res.sendStatus(200);

  try {
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const waId = message.from;

    if (message.type === 'interactive' && message.interactive?.nfm_reply) {
      const nfm = message.interactive.nfm_reply;
      const { flowData } = desencriptarFlow(nfm.encrypted_aes_key, nfm.initial_vector, nfm.response_json);
      const idReclamo = await registrarReclamo(flowData, waId);
      if (idReclamo) {
        await enviarMensajeWhatsApp(waId, { type: "text", text: { body: `✅ Reclamo ID: *${idReclamo}*\n\nCompartí tu ubicación si querés 📍` }});
      }
    } else if (message.type === 'location') {
      await guardarUbicacion(waId, message.location.latitude, message.location.longitude);
      await enviarMensajeWhatsApp(waId, { type: "text", text: { body: "📍 Ubicación guardada." }});
    } else {
      await enviarBienvenidaYPlantilla(waId);
    }
  } catch (e) {
    console.error("❌ Error mensaje:", e.message);
  }
});

app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
