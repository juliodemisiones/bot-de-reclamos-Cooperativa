const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

const port = process.env.PORT || 3000;

// Configuración de Seguridad
const VERIFY_TOKEN = "cooperativa90"; 
// Extraemos la clave de las variables de entorno de Render
const PRIVATE_KEY = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') : null;

// 1. Verificación del Webhook (GET)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }
    res.sendStatus(403);
});

// 2. Procesamiento del Flujo (POST)
app.post('/webhook', (req, res) => {
    const { encrypted_flow_data, encrypted_aes_key, initial_vector } = req.body;

    if (!encrypted_flow_data) {
        return res.status(200).send('EVENT_RECEIVED');
    }

    try {
        // --- PASO 1: Descifrar la clave AES enviada por Meta ---
        const decryptedAesKey = crypto.privateDecrypt(
            {
                key: PRIVATE_KEY,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: "sha256",
            },
            Buffer.from(encrypted_aes_key, 'base64')
        );

        // --- PASO 2: Descifrar los datos del formulario ---
        const flowBuffer = Buffer.from(encrypted_flow_data, 'base64');
        const tagEntrada = flowBuffer.slice(-16);
        const dataEntrada = flowBuffer.slice(0, -16);
        const decipher = crypto.createDecipheriv('aes-128-gcm', decryptedAesKey, Buffer.from(initial_vector, 'base64'));
        decipher.setAuthTag(tagEntrada);
        
        let decrypted = decipher.update(dataEntrada, 'binary', 'utf8');
        decrypted += decipher.final('utf8');
        const flowResponse = JSON.parse(decrypted);
        
        console.log('--- RECLAMO RECIBIDO ---');
        console.log(flowResponse);

        // --- PASO 3: Preparar la respuesta para el éxito ---
        const responseBody = {
            version: "7.3",
            data_api_version: "3.0",
            screen: "SUCCESS", 
            data: {
                mensaje_final: "Su reclamo ha sido registrado en el sistema de la Cooperativa.",
                numero_reclamo: "RE-" + Math.floor(1000 + Math.random() * 9000)
            }
        };

        // --- PASO 4: Encriptar la respuesta de vuelta a Meta ---
        const responseIv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-128-gcm', decryptedAesKey, responseIv);
        
        const encryptedBody = Buffer.concat([
            cipher.update(JSON.stringify(responseBody), 'utf8'),
            cipher.final()
        ]);
        
        const tagSalida = cipher.getAuthTag();
        // El formato final debe ser: Datos Encriptados + Tag de Autenticación + IV
        const finalBuffer = Buffer.concat([encryptedBody, tagSalida, responseIv]);

        res.status(200).send(finalBuffer.toString('base64'));

    } catch (error) {
        console.error('ERROR CRÍTICO:', error.message);
        // Si hay error de padding, la PRIVATE_KEY está mal configurada en Render
        res.status(500).send("Error de descifrado");
    }
});

app.listen(port, () => console.log(`Servidor de la Cooperativa corriendo en puerto ${port}`));
