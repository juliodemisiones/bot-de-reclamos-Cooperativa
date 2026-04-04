const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

const port = process.env.PORT || 3000;
const VERIFY_TOKEN = "cooperativa90";

// Ajuste para aceptar PRIVATE KEY (PKCS#8) o RSA PRIVATE KEY (PKCS#1)
const PRIVATE_KEY = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') : null;

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
            
            console.log('Datos recibidos:', flowResponse);

            // 3. RESPUESTA (Aquí cambiaremos "SUCCESS" por el ID de tu JSON)
            const responseBody = {
                version: "2.1",
                screen: "SUCCESS", // <--- PASAME EL JSON PARA CORREGIR ESTO
                data: {
                    extension_message_response: {
                        params: { 
                            // Aquí van los datos que tu pantalla final espera mostrar
                            nombre: flowResponse.nombre || "Usuario" 
                        }
                    }
                }
            };

            // 4. ENCRIPTAR RESPUESTA (Formato Buffer Directo)
            const responseIv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-128-gcm', decryptedAesKey, responseIv);
            
            const encryptedBody = Buffer.concat([
                cipher.update(JSON.stringify(responseBody), 'utf8'),
                cipher.final()
            ]);
            
            const tagSalida = cipher.getAuthTag();

            // Concatenación de seguridad: Datos + Tag + IV
            const finalBuffer = Buffer.concat([
                encryptedBody,
                tagSalida,
                responseIv
            ]);

            res.status(200).send(finalBuffer.toString('base64'));

        } catch (error) {
            console.error('Error crítico:', error.message);
            res.status(500).send("Error de procesamiento");
        }
    } else {
        res.status(200).send('EVENT_RECEIVED');
    }
});

app.listen(port, () => console.log(`Servidor Cooperativa en puerto ${port}`));
