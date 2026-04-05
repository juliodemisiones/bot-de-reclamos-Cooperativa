const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

const port = process.env.PORT || 3000;
const PRIVATE_KEY = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') : null;

app.get('/webhook', (req, res) => {
  res.status(200).send(req.query['hub.challenge']);
});

app.post('/webhook', (req, res) => {
  const body = req.body;

  // 1. RESPUESTA AL PING (JSON PLANO)
  if (body.action === "ping") {
    return res.status(200).json({
      data: { status: "active" }
    });
  }

  // 2. RESPUESTA A DATA_EXCHANGE (CIFRADA)
  try {
    const aesKey = crypto.privateDecrypt(
      { key: PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(body.encrypted_aes_key, 'base64')
    );

    // Ajuste: Eliminamos 'version' y 'screen' para la prueba de estado
    // Meta a veces se marea si enviamos de más en el Health Check
    const responsePayload = {
      data: { 
        msj: "✅ Conexión Exitosa" 
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

    console.log("🚀 Enviando carga simplificada");
    res.status(200).send(finalBuffer.toString('base64'));

  } catch (e) {
    console.error("❌ Error:", e.message);
    res.status(500).send("Error");
  }
});

app.listen(port, () => console.log("Servidor Cooperativa en Línea"));
