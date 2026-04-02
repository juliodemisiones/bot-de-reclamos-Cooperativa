const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const app = express();

app.use(express.json());

// Esta función es la que "abre" el mensaje cifrado de Meta
function decryptRequest(body, privateKey) {
    const { encrypted_flow_data, encrypted_aes_key, initial_vector } = body;

    const decryptedAesKey = crypto.privateDecrypt(
        { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
        Buffer.from(encrypted_aes_key, 'base64')
    );

    const decipher = crypto.createDecipheriv('aes-128-gcm', decryptedAesKey, Buffer.from(initial_vector, 'base64'));
    let decrypted = decipher.update(Buffer.from(encrypted_flow_data, 'base64'), 'base64', 'utf8');
    // Nota: El tag de autenticación está al final de los datos encriptados en GCM
    return JSON.parse(decrypted);
}

app.post('/', async (req, res) => {
    try {
        // 1. Responder al PING de Meta (Círculo Verde)
        if (req.body.action === 'ping' || !req.body.encrypted_flow_data) {
            return res.json({ version: "3.0", data: { status: "active" } });
        }

        // 2. Descifrar los datos reales del reclamo
        const privateKey = process.env.PRIVATE_KEY.replace(/\\n/g, '\n');
        const decryptedData = decryptRequest(req.body, privateKey);

        // 3. Enviar a Google Sheets
        await axios.post(process.env.GOOGLE_SHEET_URL, decryptedData);

        // 4. Responder éxito a WhatsApp
        res.json({
            version: "3.0",
            screen: "FINAL",
            data: { extension_message_response: { params: { status: "success" } } }
        });

    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({ error: "Internal Error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Puente corriendo en puerto ${PORT}`));
