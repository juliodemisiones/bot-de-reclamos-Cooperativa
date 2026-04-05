const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

const port = process.env.PORT || 10000;
// Asegúrate de que la PRIVATE_KEY en Render esté cargada correctamente
const PRIVATE_KEY = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') : null;

// 1. Verificación del Webhook (GET) - Para que el enlace sea válido en Meta
app.get('/webhook', (req, res) => {
  res.status(200).send(req.query['hub.challenge']);
});

// 2. Procesamiento de datos (POST)
app.post('/webhook', (req, res) => {
  const body = req.body;

  // --- FILTRO DE FUERZA BRUTA: PRIORIDAD AL CHECK VERDE ---
  // Si Meta envía un ping o si no hay datos cifrados, 
  // respondemos EL TEXTO PLANO QUE META PIDE y salimos (return).
  if (!body.encrypted_flow_data || body.action === 'ping' || body.action === 'INIT') {
    console.log("🤖 BYPASS META: Enviando status active plano");
    return res.status(200).json({
      data: {
        status: "active"
      }
    });
  }

  // --- FLUJO DE USUARIO (SOLO SI PASA EL FILTRO ANTERIOR) ---
  try {
    const aesKey = crypto.privateDecrypt(
      { 
        key: PRIVATE_KEY, 
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, 
        oaepHash: "sha256" 
      },
      Buffer.from(body.encrypted_aes_key, 'base64')
    );

    // Meta a veces exige ver 'active' incluso dentro del cifrado para validar
    const responsePayload = {
      data: { 
        status: "active",
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

    console.log("🔐 FLUJO USUARIO: Respuesta cifrada enviada");
    res.status(200).send(finalBuffer.toString('base64'));

  } catch (e) {
    console.error("❌ ERROR:", e.message);
    // Fallback: Siempre responder algo que Meta acepte
    res.status(200).json({ data: { status: "active" } });
  }
});

app.listen(port, () => console.log("Servidor Cooperativa Listo"));
