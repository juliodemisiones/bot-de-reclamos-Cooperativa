const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

const port = process.env.PORT || 3000;
const VERIFY_TOKEN = "cooperativa90";

// Clave privada (Render maneja \n como string)
const PRIVATE_KEY = process.env.PRIVATE_KEY 
  ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') 
  : null;

// 1. Verificación Webhook (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// 2. Procesamiento de datos (POST)
app.post('/webhook', (req, res) => {
  const body = req.body || {};

  // Ping de salud
  if (body.action === "ping") {
    return res.status(200).json({ version: "3.0", data: { status: "active" } });
  }

  const { encrypted_flow_data, encrypted_aes_key, initial_vector } = body;
  if (!encrypted_flow_data) return res.status(200).send('EVENT_RECEIVED');

  try {
    // A. Descifrar clave AES
    const decryptedAesKey = crypto.privateDecrypt(
      {
        key: PRIVATE_KEY,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(encrypted_aes_key, 'base64')
    );

    // B. Descifrar datos del Flow
    const flowBuffer = Buffer.from(encrypted_flow_data, 'base64');
    const tagIn = flowBuffer.slice(-16);
    const dataIn = flowBuffer.slice(0, -16);
    const iv = Buffer.from(initial_vector, 'base64');

    const decipher = crypto.createDecipheriv('aes-128-gcm', decryptedAesKey, iv);
    decipher.setAuthTag(tagIn);
    let decrypted = decipher.update(dataIn, 'binary', 'utf8');
    decrypted += decipher.final('utf8');
    const flowData = JSON.parse(decrypted);

    console.log('✅ Reclamo recibido:', flowData);

    // C. RESPUESTA PARA EL FLUJO
    // Solo enviamos 'data' para que rellene la pantalla SUCCESS definida en el routing_model
    const responsePayload = {
      version: "3.0",
      data: {
        mensaje_final: "Su reclamo ha sido registrado correctamente en el sistema de la Cooperativa."
      }
    };

    // D. Encriptar respuesta (Protocolo IV Flip)
    const flippedIv = Buffer.from(iv).map(byte => byte ^ 0xFF);
    const cipher = crypto.createCipheriv('aes-128-gcm', decryptedAesKey, flippedIv);
    
    const cipherText = Buffer.concat([
      cipher.update(JSON.stringify(responsePayload), 'utf8'),
      cipher.final()
    ]);

    const tagOut = cipher.getAuthTag();
    
    // Formato: [Texto Cifrado][Tag de 16 bytes]
    const finalResponse = Buffer.concat([cipherText, tagOut]);

    res.status(200).send(finalResponse.toString('base64'));

  } catch (e) {
    console.error('❌ Error de seguridad:', e.message);
    res.status(500).send("Error");
  }
});

app.listen(port, () => console.log(`🚀 Servidor Cooperativa activo en puerto ${port}`));
