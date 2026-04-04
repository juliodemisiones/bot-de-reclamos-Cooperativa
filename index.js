const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

const port = process.env.PORT || 3000;
const VERIFY_TOKEN = "cooperativa90";

// Clave privada desde variables de entorno de Render
let PRIVATE_KEY = process.env.PRIVATE_KEY 
  ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') 
  : null;

if (!PRIVATE_KEY) {
  console.error("❌ PRIVATE_KEY no está configurada en las variables de entorno de Render");
}

// ======================
// 1. Verificación del Webhook (GET)
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
  const { encrypted_flow_data, encrypted_aes_key, initial_vector } = req.body;

  // Si no hay datos encriptados → respuesta simple (para otros eventos)
  if (!encrypted_flow_data || !encrypted_aes_key || !initial_vector) {
    return res.status(200).send('EVENT_RECEIVED');
  }

  try {
    console.log("🔐 Recibiendo datos encriptados del Flow...");

    // PASO 1: Desencriptar la clave AES con tu clave privada RSA
    const decryptedAesKey = crypto.privateDecrypt(
      {
        key: PRIVATE_KEY,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(encrypted_aes_key, 'base64')
    );

    // PASO 2: Desencriptar los datos del Flow (AES-128-GCM)
    const flowBuffer = Buffer.from(encrypted_flow_data, 'base64');
    const authTag = flowBuffer.slice(-16);
    const encryptedData = flowBuffer.slice(0, -16);

    const ivBuffer = Buffer.from(initial_vector, 'base64');

    const decipher = crypto.createDecipheriv('aes-128-gcm', decryptedAesKey, ivBuffer);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedData);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    const flowData = JSON.parse(decrypted.toString('utf8'));

    console.log('✅ Datos recibidos del formulario:', flowData);

    // ======================
    // PASO 3: Preparar respuesta (pantalla SUCCESS)
    // ======================
    const responsePayload = {
      version: "7.3",           // importante mantener la versión de tu Flow
      screen: "SUCCESS",
      data: {
        mensaje_final: "Su reclamo ha sido registrado correctamente en el sistema.",
        numero_reclamo: "RE-" + Date.now().toString().slice(-6)
      }
    };

    // ======================
    // PASO 4: Encriptar la respuesta correctamente
    // ======================
    // ¡¡FLIP DEL IV!! ← Este es el paso que faltaba
    const flippedIv = Buffer.from(ivBuffer).map(byte => byte ^ 0xFF);

    const cipher = crypto.createCipheriv('aes-128-gcm', decryptedAesKey, flippedIv);

    const encryptedResponse = Buffer.concat([
      cipher.update(JSON.stringify(responsePayload), 'utf8'),
      cipher.final(),
      cipher.getAuthTag()
    ]);

    // Enviar como base64 (texto plano, NO JSON)
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
