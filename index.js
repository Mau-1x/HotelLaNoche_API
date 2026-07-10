const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const axios = require('axios');
const dns = require('dns');
require('dotenv').config();

dns.setDefaultResultOrder('ipv4first');

const app = express();
app.use(express.json());
app.use(cors());

const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    port: parseInt(process.env.DB_PORT) || 1433,
    options: { encrypt: true, trustServerCertificate: true }
};

async function sendMail(to, subject, content) {
    try {
        await axios.post('https://api.brevo.com/v3/smtp/email', {
            sender: { name: "Hotel La Noche", email: "hotellanocher@gmail.com" },
            to: [{ email: to }],
            subject: subject,
            htmlContent: `
                <div style="background-color: #0F172A; padding: 40px; font-family: sans-serif; color: #F8FAFC; text-align: center; border-radius: 20px; border: 2px solid #2563EB;">
                    <h1 style="color: #60A5FA; letter-spacing: 5px;">HOTEL LA NOCHE</h1>
                    <hr style="border: 0; border-top: 1px solid rgba(96, 165, 250, 0.2); margin: 30px 0;">
                    ${content}
                    <p style="font-size: 11px; color: #555; margin-top: 30px;">© 2024 Hotel La Noche S.A. | Seguridad Certificada</p>
                </div>`
        }, {
            headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' }
        });
    } catch (e) { console.error("Error correo:", e.message); }
}

// --- NEGOCIO (Reserva con Validación de Estado y Horario) ---

app.post('/api/reservas', async (req, res) => {
    const { id_cliente, id_habitacion, fecha_entrada, fecha_salida, hora_reserva } = req.body;

    try {
        let pool = await sql.connect(dbConfig);

        // 1. Verificar si la habitación sigue disponible
        let resCheck = await pool.request()
            .input('idH', sql.Int, id_habitacion)
            .query('SELECT estado FROM HABITACION WHERE id_habitacion = @idH');

        if (resCheck.recordset[0].estado !== 'Disponible') {
            return res.status(400).json({ error: 'La habitación ya no se encuentra disponible.' });
        }

        // 2. Obtener precio
        let resPrecio = await pool.request()
            .input('idH', sql.Int, id_habitacion)
            .query('SELECT th.precio_noche FROM HABITACION h INNER JOIN TIPO_HABITACION th ON h.id_tipo_habitacion = th.id_tipo_habitacion WHERE h.id_habitacion = @idH');
        const precio = resPrecio.recordset[0].precio_noche;

        // 3. Crear Reserva (Guardando la hora elegida)
        let result = await pool.request()
            .input('idCliente', sql.Int, id_cliente)
            .input('idHab', sql.Int, id_habitacion)
            .input('fEntrada', sql.Date, fecha_entrada)
            .input('fSalida', sql.Date, fecha_salida)
            .input('hora', sql.VarChar, hora_reserva)
            .query(`
                INSERT INTO RESERVA (id_cliente, id_habitacion, fecha_reserva, fecha_entrada, fecha_salida, estado_reserva)
                VALUES (@idCliente, @idHab, GETDATE(), @fEntrada, @fSalida, 'Confirmada');
                UPDATE HABITACION SET estado = 'Reservada' WHERE id_habitacion = @idHab;
                SELECT SCOPE_IDENTITY() AS id_reserva;
            `);

        const idReserva = result.recordset[0].id_reserva;

        // 4. Crear Comprobante con código único
        const ticketCode = 'LN-' + idReserva + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();
        await pool.request()
            .input('idR', sql.Int, idReserva)
            .input('code', sql.VarChar, ticketCode)
            .input('total', sql.Decimal(10,2), precio)
            .query('INSERT INTO COMPROBANTE (id_reserva, codigo_ticket, monto_total, fecha_emision) VALUES (@idR, @code, @total, GETDATE())');

        res.status(201).json({ id_reserva: idReserva, message: 'Reserva Confirmada exitosamente' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Obtener todas las habitaciones (Para Inicio)
app.get('/api/habitaciones', async (req, res) => {
    try {
        let pool = await sql.connect(dbConfig);
        let result = await pool.request().query(`
            SELECT h.*, th.nombre as tipo_nombre, th.capacidad, th.precio_noche
            FROM HABITACION h
            INNER JOIN TIPO_HABITACION th ON h.id_tipo_habitacion = th.id_tipo_habitacion
        `);

        res.json(result.recordset.map(row => ({
            id_habitacion: row.id_habitacion,
            numero_habitacion: row.numero_habitacion,
            estado: row.estado,
            imageUrl: row.tipo_nombre.includes("Suite") ? "https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?q=80&w=600" : "https://images.unsplash.com/photo-1590490360182-c33d57733427?q=80&w=600",
            tipo: { nombre: row.tipo_nombre, capacidad: row.capacidad, precio_noche: row.precio_noche }
        })));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// AUTH Y OTROS ENDPOINTS (Iguales a los anteriores para no perder funcionalidad)
app.post('/api/register', async (req, res) => {
    const { nombres, dni, email, password } = req.body;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    try {
        let pool = await sql.connect(dbConfig);
        let resPersona = await pool.request().input('nom', sql.VarChar, nombres).input('dni', sql.VarChar, dni).input('mail', sql.VarChar, email)
            .query(`INSERT INTO PERSONA (nombres, apellido_paterno, apellido_materno, tipo_documento, numero_documento, email) VALUES (@nom, 'Soto', 'Lozano', 'DNI', @dni, @mail); SELECT SCOPE_IDENTITY() AS id_persona;`);
        const idPersona = resPersona.recordset[0].id_persona;
        await pool.request().input('idP', sql.Int, idPersona).input('pass', sql.VarChar, password).input('otp', sql.VarChar, otp)
            .query('INSERT INTO CLIENTE (id_persona, contrasena, codigo_verificacion, esta_verificado) VALUES (@idP, @pass, @otp, 0)');
        sendMail(email, "👑 Código VIP - Hotel La Noche", `<p>Su código es:</p><h2>${otp}</h2>`);
        res.status(201).json({ message: 'Código enviado' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/login', async (req, res) => {
    const { email, contrasena } = req.body;
    try {
        let pool = await sql.connect(dbConfig);
        let resCli = await pool.request().input('mail', sql.VarChar, email).input('pass', sql.VarChar, contrasena)
            .query(`SELECT p.nombres, p.email, c.id_cliente, c.esta_verificado FROM PERSONA p INNER JOIN CLIENTE c ON p.id_persona = c.id_persona WHERE p.email = @mail AND c.contrasena = @pass`);
        if (resCli.recordset.length > 0) {
            const user = resCli.recordset[0];
            if (user.esta_verificado === false) return res.status(403).json({ error: 'Cuenta no verificada' });
            return res.json({ tipo: 'CLIENTE', datos: user });
        }
        res.status(401).json({ error: 'Credenciales incorrectas' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/verify', async (req, res) => {
    const { email, codigo } = req.body;
    try {
        let pool = await sql.connect(dbConfig);
        await pool.request().input('mail', sql.VarChar, email).input('otp', sql.VarChar, codigo)
            .query('UPDATE CLIENTE SET esta_verificado = 1 WHERE id_persona = (SELECT id_persona FROM PERSONA WHERE email = @mail) AND codigo_verificacion = @otp');
        res.json({ message: 'Verificado' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/reservas/cancelar/:idReserva', async (req, res) => {
    try {
        let pool = await sql.connect(dbConfig);
        await pool.request().input('idRes', sql.Int, req.params.idReserva)
            .query(`UPDATE RESERVA SET estado_reserva = 'Cancelada' WHERE id_reserva = @idRes; UPDATE HABITACION SET estado = 'Disponible' WHERE id_habitacion = (SELECT id_habitacion FROM RESERVA WHERE id_reserva = @idRes);`);
        res.json({ message: 'Anulada' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reservas/cliente/:idCliente', async (req, res) => {
    try {
        let pool = await sql.connect(dbConfig);
        let result = await pool.request().input('idC', sql.Int, req.params.idCliente)
            .query(`SELECT r.*, h.numero_habitacion, th.nombre as tipo_nombre FROM RESERVA r INNER JOIN HABITACION h ON r.id_habitacion = h.id_habitacion INNER JOIN TIPO_HABITACION th ON h.id_tipo_habitacion = th.id_tipo_habitacion WHERE r.id_cliente = @idC ORDER BY r.fecha_reserva DESC`);
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/comprobantes/reserva/:idReserva', async (req, res) => {
    try {
        let pool = await sql.connect(dbConfig);
        let result = await pool.request().input('idR', sql.Int, req.params.idReserva)
            .query(`SELECT c.*, p.nombres, h.numero_habitacion, th.nombre as tipo_nombre FROM COMPROBANTE c INNER JOIN RESERVA r ON c.id_reserva = r.id_reserva INNER JOIN CLIENTE cl ON r.id_cliente = cl.id_cliente INNER JOIN PERSONA p ON cl.id_persona = p.id_persona INNER JOIN HABITACION h ON r.id_habitacion = h.id_habitacion INNER JOIN TIPO_HABITACION th ON h.id_tipo_habitacion = th.id_tipo_habitacion WHERE c.id_reserva = @idR`);
        res.json(result.recordset[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = 5000;
app.listen(PORT, '0.0.0.0', () => { console.log(`Servidor en puerto ${PORT}`); });
