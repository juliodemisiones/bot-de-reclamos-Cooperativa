const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
// Usamos el parser simple para evitar discrepancias de tamaño
app.use(bodyParser.json());

const port = process.env.PORT || 3000;
const PRIVATE_KEY = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') : null;

// 1. Webhook GET (Verificación de URL)
app.get('/webhook', (req, res) => {
  res.status(200).send(req.query['hub.challenge']);
});

// 2. Webhook POST (Procesamiento)
app.post('/webhook', (req, res) => {
  const body = req.body;

  // --- RESPUESTA AL PING (Captura "Resultado esperado") ---
  // Según tu captura, Meta solo espera el objeto 'data'
  if (body.action === "ping") {
    console.log("🏓 Ping de Meta recibido");
    return res.status(200).json({
      data: {
        status: "active"
      }
    });
  }

  try {
    // --- DESCIFRADO ---
    const aesKey = crypto.privateDecrypt(
      { 
        key: PRIVATE_KEY, 
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, 
        oaepHash: "sha256" 
      },
      Buffer.from(body.encrypted_aes_key, 'base64')
    );

    // --- CARGA DE DATOS (Captura "Resultado real") ---
    // Eliminamos 'version' del JSON cifrado porque Meta dijo que "no era lo esperado"
    const responsePayload = {
      data: { 
        msj: "✅ ¡Conexión con la Cooperativa Exitosa!" 
      }
    };

    // --- CIFRADO (Protocolo IV Flip) ---
    const iv = Buffer.from(body.initial_vector, 'base64');
    const flippedIv = Buffer.from(iv).map(byte => byte ^ 0xFF);
    const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flippedIv);
    
    const cipherText = Buffer.concat([
      cipher.update(JSON.stringify(responsePayload), 'utf8'), 
      cipher.final()
    ]);
    
    // Concatenamos: DATOS CIFRADOS + TAG DE AUTENTICACIÓN (16 bytes)
    const finalBuffer = Buffer.concat([cipherText, cipher.getAuthTag()]);

    console.log("🚀 Enviando respuesta cifrada...");
    res.status(200).send(finalBuffer.toString('base64'));

  } catch (e) {
    console.error("❌ Error en el proceso:", e.message);
    res.status(500).send("Error de servidor");
  }
});

app.listen(port, () => console.log(`🚀 Servidor Cooperativa en puerto ${port}`));
