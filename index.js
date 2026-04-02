const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const app = express();

app.use(express.json());

function decryptRequest(body, privateKey) {
    const { encrypted_flow_data, encrypted_aes_key, initial_vector } = body;

    const decryptedAesKey = crypto.privateDecrypt(
        { 
            key: privateKey, 
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha256"
        },
        Buffer.from(encrypted_aes_key, 'base64')
    );

    const decipher = crypto.createDecipheriv('aes-128-gcm', decryptedAesKey, Buffer.from(initial_vector, 'base64'));
    let decrypted = decipher.update(Buffer.from(encrypted_flow_data, 'base64'), 'base64', 'utf8');
    return JSON.parse(decrypted);
}

app.post('/', async (req, res) => {
    try {
        if (req.body.action === 'ping' || !req.body.encrypted_flow_data) {
            return res.json({ version: "3.0", data: { status: "active" } });
        }

        // --- SUPER LÓGICA DE LIMPIEZA DE CLAVE ---
        let rawKey = process.env.PRIVATE_KEY.trim();
        
        // Si no tiene los guiones, asumimos que es Base64 y la convertimos correctamente
        if (!rawKey.includes('BEGIN PRIVATE KEY')) {
            try {
                // Intentamos leerla como Base64 por si viene de Replit
                const buffer = Buffer.from(rawKey, 'base64');
                rawKey = `-----BEGIN PRIVATE KEY-----\n${buffer.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;
            } catch (e) {
                // Si falla, solo le ponemos los encabezados
                rawKey = `-----BEGIN PRIVATE KEY-----\n${rawKey}\n-----END PRIVATE KEY-----`;
            }
        }
        // ------------------------------------------

        const decryptedData = decryptRequest(req.body, rawKey);
        await axios.post(process.env.GOOGLE_SHEET_URL, decryptedData);

        res.json({
            version: "3.0",
            screen: "FINAL",
            data: { extension_message_response: { params: { status: "success" } } }
        });

    } catch (error) {
        console.error("Error detallado:", error.message);
        res.status(500).json({ error: "Internal Error", message: error.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Puente de la Cooperativa listo`));
