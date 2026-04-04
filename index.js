const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

const port = process.env.PORT || 3000;

// Configuración de Seguridad
const VERIFY_TOKEN = "cooperativa90"; // El que pusiste en Meta for Developers
const PRIVATE_KEY = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') : null;

// Verificación del Webhook (GET)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// Procesamiento de Datos del Flujo (POST)
app.post('/webhook', (req, res) => {
    const { encrypted_flow_data, encrypted_aes_key, initial_vector } = req.body;

    if (encrypted_flow_data) {
        try {
            // 1. Descifrar la clave AES enviada por WhatsApp
            const decryptedAesKey = crypto.privateDecrypt(
                {
                    key: PRIVATE_KEY,
                    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                    oaepHash: "sha256",
                },
                Buffer.from(encrypted_aes_key, 'base64')
            );

            // 2. Descifrar el contenido del flujo
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

            // 3. Preparar la respuesta para el celular
            // Aquí le decimos al flujo que salte a la pantalla "SUCCESS"
            const responseBody = {
                version: "3.0",
                screen: "SUCCESS", 
                data: {
                    mensaje_final: "Gracias por tu reporte. Un técnico revisará el caso.",
                    numero_reclamo: Math.floor(Math.random() * 10000).toString()
                }
            };

            // 4. Encriptar la respuesta de vuelta
            const responseIv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-128-gcm', decryptedAesKey, responseIv);
            
            const encryptedBody = Buffer.concat([
                cipher.update(JSON.stringify(responseBody), 'utf8'),
                cipher.final()
            ]);
            
            const tagSalida = cipher.getAuthTag();
            const finalBuffer = Buffer.concat([encryptedBody, tagSalida, responseIv]);

            res.status(200).send(finalBuffer.toString('base64'));

        } catch (error) {
            console.error('ERROR EN EL BACKEND:', error.message);
            res.status(500).send("Error de procesamiento");
        }
    } else {
        res.status(200).send('EVENT_RECEIVED');
    }
});

app.listen(port, () => console.log(`Servidor de la Cooperativa corriendo en puerto ${port}`));
