app.post('/', async (req, res) => {
    // ESTA ES UNA PRUEBA PARA VER SI EL PUENTE ESTA ABIERTO
    return res.json({ 
        version: "3.0", 
        data: { status: "active" } 
    });
});
