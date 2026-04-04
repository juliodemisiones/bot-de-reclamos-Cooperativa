const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

const port = process.env.PORT || 3000;
const VERIFY_TOKEN = "cooperativa90";

// Carga la llave privada desde las variables de entorno de Render
const PRIVATE_KEY = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') : null;

// 1. RUTA PARA LA VALIDACIÓN (GET) - Para Meta
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('WEBHOOK_VERIFIED');
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// 2. RUTA PARA RECIBIR DATOS (POST) - Aquí llegan los Flows
app.post('/webhook', (req, res) => {
    const { encrypted_flow_data, encrypted_aes_key, initial_vector } = req.body;

    if (encrypted_flow_data) {
        try {
            // 1. DESCIFRAR CLAVE AES
            const decryptedAesKey = crypto.privateDecrypt(
                {
                    key: PRIVATE_KEY,
                    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                    oaepHash: "sha256",
                },
                Buffer.from(encrypted_aes_key, 'base64')
            );

            // 2. DESCIFRAR DATOS DEL FLOW
            const flowBuffer = Buffer.from(encrypted_flow_data, 'base64');
            const tagEntrada = flowBuffer.slice(-16);
            const dataEntrada = flowBuffer.slice(0, -16);
            const decipher = crypto.createDecipheriv('aes-128-gcm', decryptedAesKey, Buffer.from(initial_vector, 'base64'));
            decipher.setAuthTag(tagEntrada);
            
            let decrypted = decipher.update(dataEntrada, 'binary', 'utf8');
            decrypted += decipher.final('utf8');
            const flowResponse = JSON.parse(decrypted);
            
            console.log('Reclamo recibido:', flowResponse);

            // 3. RESPUESTA (Asegúrate que el nombre de la pantalla sea el correcto)
            const responseBody = {
                version: "2.1",
                screen: "SUCCESS", 
                data: {
                    extension_message_response: {
                        params: { nombre: flowResponse.nombre || "Usuario" }
                    }
                }
            };

            // 4. ENCRIPTAR RESPUESTA (Protocolo Estricto)
            const responseIv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-128-gcm', decryptedAesKey, responseIv);
            
            const encryptedBody = Buffer.concat([
                cipher.update(JSON.stringify(responseBody), 'utf-8'),
                cipher.final()
            ]);
            
            const tagSalida = cipher.getAuthTag();

            // CONCATENACIÓN MANUAL DE BUFFERS (Datos + Tag + IV)
            const finalBuffer = Buffer.concat([
                encryptedBody,
                tagSalida,
                responseIv
            ]);

            // IMPORTANTE: Enviar el Buffer directamente como base64
            res.status(200).send(finalBuffer.toString('base64'));

        } catch (error) {
            console.error('Error de cifrado:', error);
            res.status(500).send("Internal Server Error");
        }
    } else {
        res.status(200).send('EVENT_RECEIVED');
    }
});

            // D. ENCRIPTAR RESPUESTA (SALIDA)
            const responseIv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-128-gcm', decryptedAesKey, responseIv);
            
            const encryptedBuffer = Buffer.concat([
                cipher.update(JSON.stringify(responseBody), 'utf8'),
                cipher.final()
            ]);
            
            const tagSalida = cipher.getAuthTag();

            // CONCATENACIÓN: Datos + Tag + IV
            const finalResponseBuffer = Buffer.concat([
                encryptedBuffer,
                tagSalida,
                responseIv
            ]);

            // Enviamos todo como un único string Base64
            res.status(200).send(finalResponseBuffer.toString('base64'));

        } catch (error) {
            console.error('Error de cifrado:', error);
            res.sendStatus(500);
        }
    } else {
        // Respuesta para eventos que no son Flows (opcional)
        res.status(200).send('EVENT_RECEIVED');
    }
});

app.listen(port, () => console.log(`Servidor de la Cooperativa escuchando en puerto ${port}`));
