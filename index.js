const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto'); // Necesario para descifrar los datos
const app = express().use(bodyParser.json());

const port = process.env.PORT || 3000;
const VERIFY_TOKEN = "cooperativa90";

// Carga la llave privada desde las variables de entorno de Render
// El replace ayuda a manejar correctamente los saltos de línea (\n)
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
    const body = req.body;

    // Verificar si el mensaje viene de un Flow (contiene encrypted_flow_data)
    if (body.encrypted_flow_data) {
        try {
            if (!PRIVATE_KEY) {
                console.error("ERROR: No se encontró la PRIVATE_KEY en las variables de entorno.");
                return res.sendStatus(500);
            }

            // --- LÓGICA DE DESCIFRADO ---
            const { encrypted_flow_data, encrypted_aes_key, initial_vector } = body;

            // 1. Descifrar la clave AES usando tu Llave Privada RSA
            const decryptedAesKey = crypto.privateDecrypt(
                {
                    key: PRIVATE_KEY,
                    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                    oaepHash: "sha256",
                },
                Buffer.from(encrypted_aes_key, 'base64')
            );

            // 2. Descifrar los datos del Flow usando la clave AES obtenida
            const decipher = crypto.createDecipheriv(
                'aes-128-gcm',
                decryptedAesKey,
                Buffer.from(initial_vector, 'base64')
            );
            
            // Nota: En Flows, el tag de autenticación suele estar al final de encrypted_flow_data
            const encryptedBuffer = Buffer.from(encrypted_flow_data, 'base64');
            const tag = encryptedBuffer.slice(-16);
            const data = encryptedBuffer.slice(0, -16);
            
            decipher.setAuthTag(tag);
            
            let decrypted = decipher.update(data, 'binary', 'utf8');
            decrypted += decipher.final('utf8');

            const flowResponse = JSON.parse(decrypted);
            console.log('Datos del reclamo descifrados:', flowResponse);

            // --- AQUÍ PROCESAS EL RECLAMO ---
            // Ejemplo: Guardar flowResponse.tipo_reclamo y flowResponse.nro_cuenta en Google Sheets
            
            // 3. Responder a Meta (obligatorio enviar un JSON vacío o con la siguiente pantalla)
            res.status(200).json({
                version: "2.1",
                screen: "SUCCESS", // Nombre de la pantalla de éxito en tu JSON de Flow
                data: {
                    extension_message_response: {
                        params: {
                            nombre: flowResponse.nombre || "Usuario"
                        }
                    }
                }
            });

        } catch (error) {
            console.error('Error al descifrar el Flow:', error);
            res.sendStatus(500);
        }
    } else {
        // Eventos normales de WhatsApp (mensajes de texto, etc.)
        console.log('Evento estándar recibido:', JSON.stringify(body, null, 2));
        res.status(200).send('EVENT_RECEIVED');
    }
});

app.listen(port, () => console.log(`Servidor de Cooperativa escuchando en puerto ${port}`));
