const express = require('express');
const bodyParser = require('body-parser');
const app = express().use(bodyParser.json());

const port = process.env.PORT || 3000;
const VERIFY_TOKEN = "cooperativa90";

// 1. RUTA PARA LA VALIDACIÓN (GET)
// Esto es lo que Meta consulta cuando le das a "Verificar y guardar"
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// 2. RUTA PARA RECIBIR DATOS (POST)
// Aquí llegarán los mensajes y eventos de los Flows
app.post('/webhook', (req, res) => {
    const body = req.body;

    console.log('Evento recibido:', JSON.stringify(body, null, 2));

    if (body.object) {
        // Aquí es donde procesaremos los reclamos más adelante
        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

app.listen(port, () => console.log(`Servidor escuchando en puerto ${port}`));
