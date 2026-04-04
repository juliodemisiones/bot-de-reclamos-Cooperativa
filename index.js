const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

const port = process.env.PORT || 3000;
const VERIFY_TOKEN = "cooperativa90";

// Clave privada
let PRIVATE_KEY = process.env.PRIVATE_KEY
  ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n')
  : null;

if (!PRIVATE_KEY) {
  console.error("❌ PRIVATE_KEY no está configurada en Render");
}

// ======================
// 1. Verificación GET
// ======================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado correctamente");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ======================
// 2. Procesamiento del Flow (POST)
// ======================
app.post('/webhook', (req, res) => {
  const body = req.body;

  // === NUEVO: Detectar Health Check (ping) ===
  if (body.action === "ping" || (body.version === "3.0" && body.action === "ping")) {
    console.log("🏓 Health Check (ping) recibido - Respondiendo correctamente");
    
    const pingResponse = {
      version: "3.0",
      data: {
        status: "active"
      }
    };

    return res.status(200).json(pingResponse);   // ← Respuesta SIMPLE (JSON)
  }

  // Si NO es ping → es un data_exchange normal (con encriptación)
  const { encrypted_flow_data, encrypted_aes_key, initial_vector } = body;

  if (!encrypted_flow_data || !encrypted_aes_key || !initial_vector) {
    return res.status(200).send('EVENT_RECEIVED');
  }

  try {
    console.log("🔐 Recibiendo datos encriptados del Flow (data_exchange)...");

    // 1. Desencriptar AES Key
    const decryptedAesKey = crypto.privateDecrypt(
      {
        key: PRIVATE_KEY,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(encrypted_aes_key, 'base64')
    );

    // 2. Desencriptar datos
    const flowBuffer = Buffer.from(encrypted_flow_data, 'base64');
    const authTag = flowBuffer.slice(-16);
    const encryptedData = flowBuffer.slice(0, -16);
    const ivBuffer = Buffer.from(initial_vector, 'base64');

    const decipher = crypto.createDecipheriv('aes-128-gcm', decryptedAesKey, ivBuffer);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedData);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    const flowData = JSON.parse(decrypted.toString('utf8'));

    console.log('✅ Flow Data recibido:', JSON.stringify(flowData, null, 2));

    const flowToken = flowData.flow_token || flowData.flowToken || "";

    // 3. Respuesta para SUCCESS
    const responsePayload = {
      screen: "SUCCESS",
      data: {
        extension_message_response: {
          params: {
            flow_token: flowToken,
            mensaje_final: "Su reclamo ha sido registrado correctamente en el sistema."
          }
        }
      }
    };

    // 4. Encriptar respuesta
    const flippedIv = Buffer.from(ivBuffer).map(byte => byte ^ 0xFF);

    const cipher = crypto.createCipheriv('aes-128-gcm', decryptedAesKey, flippedIv);

    const encryptedResponse = Buffer.concat([
      cipher.update(JSON.stringify(responsePayload), 'utf8'),
      cipher.final(),
      cipher.getAuthTag()
    ]);

    res.status(200).send(encryptedResponse.toString('base64'));

  } catch (error) {
    console.error('❌ Error al procesar el Flow:', error.message);
    console.error(error.stack);
    res.status(500).send("Error interno del servidor");
  }
});

app.listen(port, () => {
  console.log(`🚀 Servidor WhatsApp Flows corriendo en puerto ${port}`);
});
