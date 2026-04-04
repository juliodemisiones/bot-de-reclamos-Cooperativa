const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

const port = process.env.PORT || 3000;

// Configuración de Seguridad
const VERIFY_TOKEN = "cooperativa90"; 
const PRIVATE_KEY = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') : null;

// Verificación del Webhook
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }
    res.sendStatus(403);
});

// Procesamiento del Flujo
app.post('/webhook', (req, res) => {
    const { encrypted_flow_data, encrypted_aes_key, initial_vector } = req.body;

    if (!encrypted_flow_data) {
        return res.status(200).send('EVENT_RECEIVED');
    }

    try {
        const decryptedAesKey = crypto.privateDecrypt(
            {
                key: PRIVATE_KEY,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: "sha256",
            },
            Buffer.from(encrypted_aes_key, 'base64')
        );

        const flowBuffer = Buffer.from(encrypted_flow_data, 'base64');
        const tagEntrada = flowBuffer.slice(-16);
        const dataEntrada = flowBuffer.slice(0, -16);
        const decipher = crypto.createDecipheriv('aes-128-gcm', decryptedAesKey, Buffer.from(initial_vector, 'base64'));
        decipher.setAuthTag(tagEntrada);
        
        let decrypted = decipher.update(dataEntrada, 'binary', 'utf8');
        decrypted += decipher.final('utf8');
        const flowResponse = JSON.parse(decrypted);
        
        console.log('Reclamo recibido para la Cooperativa:', flowResponse);

        const responseBody = {
            version: "7.3",
            screen: "SUCCESS", 
            data: {
                mensaje_final: "Gracias por contactar a la Cooperativa Luz y Fuerza. Su reclamo ha sido registrado.",
                numero_reclamo: "TKT-" + Math.floor(1000 + Math.random() * 9000)
            }
        };

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
        console.error('ERROR:', error.message);
        res.status(500).send("Error");
    }
});

app.listen(port, () => console.log(`Servidor de la Cooperativa corriendo en puerto ${port}`));
