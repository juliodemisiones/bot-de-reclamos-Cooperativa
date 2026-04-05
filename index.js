const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

const port = process.env.PORT || 10000;
const PRIVATE_KEY = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') : null;

// Verificación inicial del Webhook
app.get('/webhook', (req, res) => {
  res.status(200).send(req.query['hub.challenge']);
});

app.post('/webhook', (req, res) => {
  const body = req.body;

  // --- DETECCIÓN DE PING / HEALTH CHECK ---
  // Si Meta pide 'ping' o el cuerpo no trae datos cifrados, respondemos lo que Meta espera ver.
  if (body.action === "ping" || !body.encrypted_flow_data) {
    console.log("✅ Respondiendo PING: status active");
    return res.status(200).json({
      data: { status: "active" }
    });
  }

  // --- DETECCIÓN DE DATA EXCHANGE ---
  try {
    const aesKey = crypto.privateDecrypt(
      { 
        key: PRIVATE_KEY, 
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, 
        oaepHash: "sha256" 
      },
      Buffer.from(body.encrypted_aes_key, 'base64')
    );

    // Respuesta que verás en el simulador
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

    console.log("🔐 Datos cifrados enviados correctamente");
    res.status(200).send(finalBuffer.toString('base64'));

  } catch (e) {
    console.error("❌ Error de descifrado:", e.message);
    // Si falla el descifrado, enviamos el ping de respaldo para no bloquear el flujo
    res.status(200).json({ data: { status: "active" } });
  }
});

app.listen(port, () => console.log(`Servidor de la Cooperativa listo en puerto ${port}`));
