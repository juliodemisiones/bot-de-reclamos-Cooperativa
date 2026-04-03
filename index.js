const express = require('express');
const crypto = require('crypto');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// 1. VALIDACIÓN DEL WEBHOOK (Para Meta)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// 2. RECEPCIÓN DE DATOS DEL FLOW (Endpoint)
app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;
        console.log('Datos recibidos de Meta:', JSON.stringify(body, null, 2));

        // Por ahora, respondemos con éxito para que Meta no de error
        res.status(200).json({
            version: "3.0",
            data: { status: "active" }
        });
    } catch (error) {
        console.error('Error procesando el POST:', error);
        res.sendStatus(500);
    }
});

app.listen(port, () => {
    console.log(`Servidor corriendo en puerto ${port}`);
});
