const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const nodemailer = require('nodemailer');
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

// Transportador Ultra-Compatible (Intento con puerto alternativo y timeouts largos)
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    connectionTimeout: 20000, // 20 segundos
    greetingTimeout: 20000,
    socketTimeout: 20000,
    tls: {
        rejectUnauthorized: false
    }
});

// --- AUTH ---

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

        const mailOptions = {
            from: `"Hotel La Noche" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: '👑 Active su Membresía VIP - Hotel La Noche',
            html: `<div style="background-color: #0A0A0A; padding: 40px; color: #F5F5F5; text-align: center; border-radius: 20px; border: 2px solid #D4AF37;">
                    <h1 style="color: #D4AF37;">HOTEL LA NOCHE</h1>
                    <p>Su código de seguridad:</p>
                    <div style="font-size: 42px; font-weight: bold; color: #D4AF37;">${otp}</div>
                   </div>`
        };

        // Enviamos sin esperar al callback para no trabar la respuesta del API
        transporter.sendMail(mailOptions).then(() => console.log("Email enviado exitosamente!")).catch(e => console.error("Error definitivo enviando:", e.message));

        res.status(201).json({ message: 'Código enviado' });
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

// --- NEGOCIO (Habitaciones, Reservas, etc) ---
app.get('/api/habitaciones', async (req, res) => {
    try {
        let pool = await sql.connect(dbConfig);
        let result = await pool.request().query(`SELECT h.*, th.nombre as tipo_nombre, th.capacidad, th.precio_noche FROM HABITACION h INNER JOIN TIPO_HABITACION th ON h.id_tipo_habitacion = th.id_tipo_habitacion`);
        const rooms = result.recordset.map(row => ({
            id_habitacion: row.id_habitacion, numero_habitacion: row.numero_habitacion, estado: row.estado,
            imageUrl: row.tipo_nombre.includes("Suite") ? "https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?q=80&w=600" : "https://images.unsplash.com/photo-1590490360182-c33d57733427?q=80&w=600",
            tipo: { nombre: row.tipo_nombre, capacidad: row.capacidad, precio_noche: row.precio_noche }
        }));
        res.json(rooms);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reservas', async (req, res) => {
    const { id_cliente, id_habitacion, fecha_entrada, fecha_salida } = req.body;
    const ticketCode = 'LN-' + Math.random().toString(36).substr(2, 6).toUpperCase();
    try {
        let pool = await sql.connect(dbConfig);
        let resPrecio = await pool.request().input('idH', sql.Int, id_habitacion).query('SELECT th.precio_noche FROM HABITACION h INNER JOIN TIPO_HABITACION th ON h.id_tipo_habitacion = th.id_tipo_habitacion WHERE h.id_habitacion = @idH');
        const subtotal = resPrecio.recordset[0].precio_noche;
        let result = await pool.request().input('idCliente', sql.Int, id_cliente).input('idHab', sql.Int, id_habitacion).input('fEntrada', sql.Date, fecha_entrada).input('fSalida', sql.Date, fecha_salida)
            .query(`INSERT INTO RESERVA (id_cliente, id_habitacion, fecha_reserva, fecha_entrada, fecha_salida, estado_reserva) VALUES (@idCliente, @idHab, GETDATE(), @fEntrada, @fSalida, 'Confirmada'); UPDATE HABITACION SET estado = 'Reservada' WHERE id_habitacion = @idHab; SELECT SCOPE_IDENTITY() AS id_reserva;`);
        const idReserva = result.recordset[0].id_reserva;
        await pool.request().input('idR', sql.Int, idReserva).input('code', sql.VarChar, ticketCode).input('total', sql.Decimal(10,2), subtotal).query('INSERT INTO COMPROBANTE (id_reserva, codigo_ticket, monto_total, fecha_emision) VALUES (@idR, @code, @total, GETDATE())');
        res.status(201).json({ id_reserva: idReserva, message: 'Reserva Exitosa' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/reservas/cancelar/:idReserva', async (req, res) => {
    try {
        let pool = await sql.connect(dbConfig);
        await pool.request().input('idRes', sql.Int, req.params.idReserva).query(`UPDATE RESERVA SET estado_reserva = 'Cancelada' WHERE id_reserva = @idRes; UPDATE HABITACION SET estado = 'Disponible' WHERE id_habitacion = (SELECT id_habitacion FROM RESERVA WHERE id_reserva = @idRes);`);
        res.json({ message: 'Anulada' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reservas/cliente/:idCliente', async (req, res) => {
    try {
        let pool = await sql.connect(dbConfig);
        let result = await pool.request().input('idC', sql.Int, req.params.idCliente).query(`SELECT r.*, h.numero_habitacion, th.nombre as tipo_nombre FROM RESERVA r INNER JOIN HABITACION h ON r.id_habitacion = h.id_habitacion INNER JOIN TIPO_HABITACION th ON h.id_tipo_habitacion = th.id_tipo_habitacion WHERE r.id_cliente = @idC ORDER BY r.fecha_reserva DESC`);
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/comprobantes/reserva/:idReserva', async (req, res) => {
    try {
        let pool = await sql.connect(dbConfig);
        let result = await pool.request().input('idR', sql.Int, req.params.idReserva).query(`SELECT c.*, p.nombres, h.numero_habitacion, th.nombre as tipo_nombre FROM COMPROBANTE c INNER JOIN RESERVA r ON c.id_reserva = r.id_reserva INNER JOIN CLIENTE cl ON r.id_cliente = cl.id_cliente INNER JOIN PERSONA p ON cl.id_persona = p.id_persona INNER JOIN HABITACION h ON r.id_habitacion = h.id_habitacion INNER JOIN TIPO_HABITACION th ON h.id_tipo_habitacion = th.id_tipo_habitacion WHERE c.id_reserva = @idR`);
        res.json(result.recordset[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = 5000;
app.listen(PORT, '0.0.0.0', () => { console.log(`Servidor corriendo en puerto ${PORT}`); });
