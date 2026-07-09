const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    port: parseInt(process.env.DB_PORT) || 1433, // Puerto estándar SQL Server
    options: {
        encrypt: true,
        trustServerCertificate: true
    }
};

// Configuración de Correo Profesional para Gmail
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Asegurar columnas de verificación
async function checkSchema() {
    try {
        let pool = await sql.connect(dbConfig);
        await pool.request().query(`
            IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'CLIENTE' AND COLUMN_NAME = 'contrasena')
                ALTER TABLE CLIENTE ADD contrasena VARCHAR(255) DEFAULT '123456';

            IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'CLIENTE' AND COLUMN_NAME = 'codigo_verificacion')
                ALTER TABLE CLIENTE ADD codigo_verificacion VARCHAR(6);

            IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'CLIENTE' AND COLUMN_NAME = 'esta_verificado')
                ALTER TABLE CLIENTE ADD esta_verificado BIT DEFAULT 0;
        `);
        console.log("Esquema de verificación verificado.");
    } catch (err) {
        console.error("Error esquema:", err.message);
    }
}
checkSchema();

// --- AUTH ---

app.post('/api/register', async (req, res) => {
    const { nombres, dni, email, password } = req.body;
    const otp = Math.floor(100000 + Math.random() * 900000).toString(); // Generar código 6 dígitos

    try {
        let pool = await sql.connect(dbConfig);

        // 1. Insertar Persona
        let resPersona = await pool.request()
            .input('nom', sql.VarChar, nombres)
            .input('dni', sql.VarChar, dni)
            .input('mail', sql.VarChar, email)
            .query(`
                INSERT INTO PERSONA (nombres, apellido_paterno, apellido_materno, tipo_documento, numero_documento, email)
                VALUES (@nom, 'User', 'App', 'DNI', @dni, @mail);
                SELECT SCOPE_IDENTITY() AS id_persona;
            `);

        const idPersona = resPersona.recordset[0].id_persona;

        // 2. Insertar Cliente con Código OTP
        await pool.request()
            .input('idP', sql.Int, idPersona)
            .input('pass', sql.VarChar, password)
            .input('otp', sql.VarChar, otp)
            .query('INSERT INTO CLIENTE (id_persona, contrasena, codigo_verificacion, esta_verificado) VALUES (@idP, @pass, @otp, 0)');

        // 3. Enviar Correo con Diseño Premium
        const mailOptions = {
            from: `"Hotel La Noche" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: '👑 Active su Membresía VIP - Hotel La Noche',
            html: `
                <div style="background-color: #0A0A0A; padding: 40px; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #F5F5F5; text-align: center; border-radius: 20px;">
                    <div style="border: 2px solid #D4AF37; padding: 30px; border-radius: 15px;">
                        <h1 style="color: #D4AF37; letter-spacing: 5px; margin-bottom: 10px;">HOTEL LA NOCHE</h1>
                        <p style="text-transform: uppercase; font-size: 12px; letter-spacing: 2px; color: #C5A059;">Experiencia de Lujo & Confort</p>

                        <hr style="border: 0; border-top: 1px solid rgba(212, 175, 55, 0.2); margin: 30px 0;">

                        <p style="font-size: 18px;">Estimado(a) <strong>${nombres}</strong>,</p>
                        <p style="color: #9E9E9E; line-height: 1.6;">Gracias por elegir la exclusividad de nuestro hotel. Para activar su cuenta y comenzar su próxima estancia, utilice el siguiente código de seguridad:</p>

                        <div style="background: #1E1E1E; padding: 20px; border-radius: 12px; margin: 30px auto; width: fit-content; border: 1px dashed #D4AF37;">
                            <span style="font-size: 42px; font-weight: bold; letter-spacing: 10px; color: #D4AF37;">${otp}</span>
                        </div>

                        <p style="font-size: 14px; color: #9E9E9E;">Este código expirará en 15 minutos.</p>

                        <hr style="border: 0; border-top: 1px solid rgba(212, 175, 55, 0.2); margin: 30px 0;">

                        <p style="font-size: 12px; color: #C5A059;">Si no ha solicitado este registro, por favor ignore este mensaje.</p>
                        <p style="font-size: 11px; color: #555; margin-top: 20px;">© 2024 Hotel La Noche S.A. | Todos los derechos reservados.</p>
                    </div>
                </div>
            `
        };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) console.log("Error enviando mail:", error);
            else console.log("Email enviado: " + info.response);
        });

        res.status(201).json({ message: 'Código enviado al correo' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Endpoint para verificar código
app.post('/api/verify', async (req, res) => {
    const { email, codigo } = req.body;
    try {
        let pool = await sql.connect(dbConfig);
        let result = await pool.request()
            .input('mail', sql.VarChar, email)
            .input('otp', sql.VarChar, codigo)
            .query(`
                UPDATE CLIENTE SET esta_verificado = 1
                WHERE id_persona = (SELECT id_persona FROM PERSONA WHERE email = @mail)
                AND codigo_verificacion = @otp;
                SELECT @@ROWCOUNT as rows;
            `);

        if (result.recordset[0].rows > 0) {
            res.json({ message: 'Cuenta activada correctamente' });
        } else {
            res.status(400).json({ error: 'Código incorrecto o inválido' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, contrasena } = req.body;
    try {
        let pool = await sql.connect(dbConfig);
        let resCli = await pool.request()
            .input('mail', sql.VarChar, email)
            .input('pass', sql.VarChar, contrasena)
            .query(`
                SELECT p.nombres, p.email, c.id_cliente, c.esta_verificado
                FROM PERSONA p
                INNER JOIN CLIENTE c ON p.id_persona = c.id_persona
                WHERE p.email = @mail AND c.contrasena = @pass
            `);

        if (resCli.recordset.length > 0) {
            const user = resCli.recordset[0];
            if (user.esta_verificado === false) {
                return res.status(403).json({ error: 'Cuenta no verificada. Revise su correo.' });
            }
            return res.json({ tipo: 'CLIENTE', datos: user });
        }
        res.status(401).json({ error: 'Credenciales incorrectas' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- RESTO DE ENDPOINTS ---
app.get('/api/habitaciones', async (req, res) => {
    try {
        let pool = await sql.connect(dbConfig);
        let result = await pool.request().query(`
            SELECT h.*, th.nombre as tipo_nombre, th.capacidad, th.precio_noche
            FROM HABITACION h
            INNER JOIN TIPO_HABITACION th ON h.id_tipo_habitacion = th.id_tipo_habitacion
        `);
        const rooms = result.recordset.map(row => ({
            id_habitacion: row.id_habitacion,
            numero_habitacion: row.numero_habitacion,
            estado: row.estado,
            imageUrl: row.tipo_nombre.includes("Suite") ? "https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?q=80&w=600" : "https://images.unsplash.com/photo-1590490360182-c33d57733427?q=80&w=600",
            tipo: { nombre: row.tipo_nombre, capacidad: row.capacidad, precio_noche: row.precio_noche }
        }));
        res.json(rooms);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reservas', async (req, res) => {
    const { id_cliente, id_habitacion, fecha_entrada, fecha_salida } = req.body;
    try {
        let pool = await sql.connect(dbConfig);
        let result = await pool.request()
            .input('idCliente', sql.Int, id_cliente)
            .input('idHab', sql.Int, id_habitacion)
            .input('fEntrada', sql.Date, fecha_entrada)
            .input('fSalida', sql.Date, fecha_salida)
            .query(`
                INSERT INTO RESERVA (id_cliente, id_habitacion, fecha_reserva, fecha_entrada, fecha_salida, estado_reserva)
                VALUES (@idCliente, @idHab, GETDATE(), @fEntrada, @fSalida, 'Confirmada');
                UPDATE HABITACION SET estado = 'Reservada' WHERE id_habitacion = @idHab;
                SELECT SCOPE_IDENTITY() AS id_reserva;
            `);
        res.status(201).json({ id_reserva: result.recordset[0].id_reserva });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/reservas/cancelar/:idReserva', async (req, res) => {
    try {
        let pool = await sql.connect(dbConfig);
        await pool.request()
            .input('idRes', sql.Int, req.params.idReserva)
            .query(`
                UPDATE RESERVA SET estado_reserva = 'Cancelada' WHERE id_reserva = @idRes;
                UPDATE HABITACION SET estado = 'Disponible' WHERE id_habitacion = (SELECT id_habitacion FROM RESERVA WHERE id_reserva = @idRes);
            `);
        res.json({ message: 'Reserva cancelada' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reservas/cliente/:idCliente', async (req, res) => {
    try {
        let pool = await sql.connect(dbConfig);
        let result = await pool.request()
            .input('idCliente', sql.Int, req.params.idCliente)
            .query(`
                SELECT r.*, h.numero_habitacion FROM RESERVA r
                INNER JOIN HABITACION h ON r.id_habitacion = h.id_habitacion
                WHERE r.id_cliente = @idCliente ORDER BY r.fecha_reserva DESC
            `);
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/comprobantes/reserva/:idReserva', async (req, res) => {
    try {
        let pool = await sql.connect(dbConfig);
        let result = await pool.request().input('idRes', sql.Int, req.params.idReserva).query('SELECT * FROM COMPROBANTE WHERE id_reserva = @idRes');
        res.json(result.recordset[0] || { error: 'No disponible' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reenviar Código OTP
app.post('/api/verify/resend', async (req, res) => {
    const { email } = req.body;
    const newOtp = Math.floor(100000 + Math.random() * 900000).toString();
    try {
        let pool = await sql.connect(dbConfig);
        await pool.request()
            .input('mail', sql.VarChar, email)
            .input('otp', sql.VarChar, newOtp)
            .query('UPDATE CLIENTE SET codigo_verificacion = @otp WHERE id_persona = (SELECT id_persona FROM PERSONA WHERE email = @mail)');

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: email,
            subject: 'Nuevo Código de Verificación - Hotel La Noche',
            html: `<p>Su nuevo código es: <b>${newOtp}</b></p>`
        };

        transporter.sendMail(mailOptions);
        res.json({ message: 'Nuevo código enviado' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = 5000;
app.listen(PORT, '0.0.0.0', () => { console.log(`Servidor corriendo en puerto ${PORT}`); });
