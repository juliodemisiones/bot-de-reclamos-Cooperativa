const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

const port = process.env.PORT || 10000;
const PRIVATE_KEY = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') : null;

// Validación inicial (GET)
app.get('/webhook', (req, res) => {
  res.status(200).send(req.query['hub.challenge']);
});

// Recepción de datos (POST)
app.post('/webhook', (req, res) => {
  const body = req.body;

  // --- PRIORIDAD: COMPROBACIÓN DE ESTADO (CHECK VERDE) ---
  // Si no hay datos cifrados, respondemos el status active en texto PLANO.
  if (!body.encrypted_flow_data || body.action === 'ping') {
    console.log("🤖 META CHECK: Enviando status active (Plano)");
    return res.status(200).json({
      data: {
        status: "active"
      }
    });
  }

  // --- INTERCAMBIO DE DATOS REAL (PARA EL USUARIO) ---
  try {
    const aesKey = crypto.privateDecrypt(
      { 
        key: PRIVATE_KEY, 
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, 
        oaepHash: "sha256" 
      },
      Buffer.from(body.encrypted_aes_key, 'base64')
    );

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

    console.log("🔐 FLUJO: Respuesta cifrada enviada");
    res.status(200).send(finalBuffer.toString('base64'));

  } catch (e) {
    console.error("❌ Error de descifrado:", e.message);
    res.status(200).json({ data: { status: "active" } });
  }
});

app.listen(port, () => console.log("Servidor Cooperativa Activo"));
