const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

const port = process.env.PORT || 3000;
const PRIVATE_KEY = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') : null;

// 1. Webhook GET (Verificación)
app.get('/webhook', (req, res) => {
  res.status(200).send(req.query['hub.challenge']);
});

// 2. Webhook POST (Procesamiento)
app.post('/webhook', (req, res) => {
  const body = req.body;

  // --- CASO PING: Resultado Esperado ---
  if (body.action === "ping") {
    console.log("🏓 Respondiendo al Ping de Meta");
    return res.status(200).json({
      data: { status: "active" }
    });
  }

  // --- CASO DATA_EXCHANGE: Resultado Real ---
  try {
    const aesKey = crypto.privateDecrypt(
      { key: PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(body.encrypted_aes_key, 'base64')
    );

    // Respuesta cifrada para el Flow
    const responsePayload = {
      version: "3.0",
      screen: "SUCCESS",
      data: { 
        msj: "✅ ¡Conexión con la Cooperativa Exitosa!" 
      }
    };

    const iv = Buffer.from(body.initial_vector, 'base64');
    const flippedIv = Buffer.from(iv).map(byte => byte ^ 0xFF);
    const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flippedIv);
    
    const cipherText = Buffer.concat([
      cipher.update(JSON.stringify(responsePayload), 'utf8'), 
      cipher.final()
    ]);
    
    const finalBuffer = Buffer.concat([cipherText, cipher.getAuthTag()]);

    console.log("🚀 Respuesta de datos enviada");
    res.status(200).send(finalBuffer.toString('base64'));

  } catch (e) {
    console.error("❌ Error de descifrado:", e.message);
    res.status(500).send("Error");
  }
});

app.listen(port, () => console.log("Servidor Cooperativa Listo"));
