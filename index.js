const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const app = express().use(bodyParser.json());

const port = process.env.PORT || 3000;
const VERIFY_TOKEN = "cooperativa90";

// Carga la llave privada desde Render
const PRIVATE_KEY = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') : null;

// 1. VALIDACIÓN (GET)
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

// 2. PROCESAMIENTO DE FLOWS (POST)
app.post('/webhook', (req, res) => {
    const { encrypted_flow_data, encrypted_aes_key, initial_vector } = req.body;

    if (encrypted_flow_data) {
        try {
            // A. DESCIFRAR LA CLAVE AES (ENTRADA)
            const decryptedAesKey = crypto.privateDecrypt(
                {
                    key: PRIVATE_KEY,
                    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                    oaepHash: "sha256",
                },
                Buffer.from(encrypted_aes_key, 'base64')
            );

            // B. DESCIFRAR LOS DATOS DEL FLOW
            const flowBuffer = Buffer.from(encrypted_flow_data, 'base64');
            const tag = flowBuffer.slice(-16);
            const data = flowBuffer.slice(0, -16);
            const decipher = crypto.createDecipheriv('aes-128-gcm', decryptedAesKey, Buffer.from(initial_vector, 'base64'));
            decipher.setAuthTag(tag);
            
            let decrypted = decipher.update(data, 'binary', 'utf8');
            decrypted += decipher.final('utf8');
            const flowResponse = JSON.parse(decrypted);
            
            console.log('Reclamo recibido:', flowResponse);

            // C. PREPARAR RESPUESTA JSON
            const responseBody = {
                version: "2.1",
                screen: "SUCCESS",
                data: {
                    extension_message_response: {
                        params: { nombre: flowResponse.nombre || "Usuario" }
                    }
                }
            };

            // D. ENCRIPTAR RESPUESTA (SALIDA) - ¡Esto es lo que faltaba!
            const responseIv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-128-gcm', decryptedAesKey, responseIv);
            let encryptedResponse = cipher.update(JSON.stringify(responseBody), 'utf8', 'base64');
            encryptedResponse += cipher.final('base64');
            const responseTag = cipher.getAuthTag().toString('base64');

            // Enviamos el paquete completo en Base64 (Datos + Tag + IV)
            const finalB64 = Buffer.from(encryptedResponse + responseTag + responseIv.toString('base64'), 'utf8').toString('base64');
            
            res.status(200).send(finalB64);

        } catch (error) {
            console.error('Error de cifrado:', error);
            res.sendStatus(500);
        }
    } else {
        res.status(200).send('EVENT_RECEIVED');
    }
});

app.listen(port, () => console.log(`Servidor de la Cooperativa en puerto ${port}`));
