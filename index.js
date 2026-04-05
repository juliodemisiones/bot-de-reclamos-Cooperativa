const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

const port = process.env.PORT || 10000;
const PRIVATE_KEY = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') : null;

// Verificación del Webhook (GET)
app.get('/webhook', (req, res) => {
  res.status(200).send(req.query['hub.challenge']);
});

app.post('/webhook', (req, res) => {
  const body = req.body;

  // --- 1. RESPUESTA AL PING / HEALTH CHECK ---
  // Meta espera exactamente: {"data": {"status": "active"}}
  if (body.action === "ping" || !body.encrypted_flow_data) {
    console.log("✅ Respondiendo PING (Health Check)");
    return res.status(200).json({
      data: { status: "active" }
    });
  }

  // --- 2. RESPUESTA AL DATA EXCHANGE (CIFRADA) ---
  try {
    const aesKey = crypto.privateDecrypt(
      { 
        key: PRIVATE_KEY, 
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, 
        oaepHash: "sha256" 
      },
      Buffer.from(body.encrypted_aes_key, 'base64')
    );

    // Estructura mínima que Meta acepta como válida
    const responsePayload = {
      data: { 
        msj: "✅ Conexión Cooperativa OK" 
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

    console.log("🔐 Respuesta cifrada enviada con éxito");
    res.status(200).send(finalBuffer.toString('base64'));

  } catch (e) {
    console.error("❌ Error de descifrado:", e.message);
    // En caso de error, devolvemos el ping para intentar salvar la conexión
    res.status(200).json({ data: { status: "active" } });
  }
});

app.listen(port, () => console.log(`Servidor Cooperativa listo en puerto ${port}`));
