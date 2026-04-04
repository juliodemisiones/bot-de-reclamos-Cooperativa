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
            
            console.log('Reclamo Cooperativa:', flowResponse);

            // 3. PREPARAR RESPUESTA
            const responseBody = {
                version: "2.1",
                screen: "SUCCESS",
                data: {
                    extension_message_response: {
                        params: { nombre: flowResponse.nombre || "Usuario" }
                    }
                }
            };

            // 4. ENCRIPTAR RESPUESTA (Ajustado para Meta)
            const responseIv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-128-gcm', decryptedAesKey, responseIv);
            
            const encryptedBuffer = Buffer.concat([
                cipher.update(JSON.stringify(responseBody), 'utf8'),
                cipher.final()
            ]);
            
            const tagSalida = cipher.getAuthTag();

            // CONCATENACIÓN CRÍTICA: Datos + Tag + IV
            const finalResponseBuffer = Buffer.concat([
                encryptedBuffer,
                tagSalida,
                responseIv
            ]);

            // Enviamos el Buffer completo como un único string Base64
            res.status(200).send(finalResponseBuffer.toString('base64'));

        } catch (error) {
            console.error('Error de cifrado:', error);
            res.sendStatus(500);
        }
    } else {
        res.status(200).send('EVENT_RECEIVED');
    }
});
