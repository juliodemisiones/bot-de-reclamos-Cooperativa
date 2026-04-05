const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

const port = process.env.PORT || 3000;
const PRIVATE_KEY = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') : null;

// Webhook GET
app.get('/webhook', (req, res) => {
  res.status(200).send(req.query['hub.challenge']);
});

// Webhook POST
app.post('/webhook', (req, res) => {
  const body = req.body;

  if (body.action === "ping") {
    return res.status(200).json({ version: "3.0", data: { status: "active" } });
  }

  try {
    // 1. Descifrar clave AES
    const aesKey = crypto.privateDecrypt(
      { key: PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(body.encrypted_aes_key, 'base64')
    );

    // 2. Respuesta ultra-simple
    const responsePayload = {
      version: "3.0",
      data: { msj: "✅ ¡Conexión con la Cooperativa Exitosa!" }
    };

    // 3. Encriptar respuesta (IV Flip)
    const iv = Buffer.from(body.initial_vector, 'base64');
    const flippedIv = Buffer.from(iv).map(byte => byte ^ 0xFF);
    const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flippedIv);
    
    const cipherText = Buffer.concat([cipher.update(JSON.stringify(responsePayload), 'utf8'), cipher.final()]);
    const finalBuffer = Buffer.concat([cipherText, cipher.getAuthTag()]);

    console.log("🚀 Respondiendo con éxito al Test");
    res.status(200).send(finalBuffer.toString('base64'));

  } catch (e) {
    console.error("❌ Error en Test:", e.message);
    res.status(500).send("Error");
  }
});

app.listen(port, () => console.log("Servidor Test Cooperativa Listo"));
