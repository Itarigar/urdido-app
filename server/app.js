require("dotenv").config();

const express = require("express");
const path = require("path");
const pool = require("./db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit-table');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "secreto_super_seguro_dev";

app.use(express.json());

// Deshabilitar caché para evitar problemas de visualización durante desarrollo
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

app.use(express.static(path.join(__dirname, "../public")));

// Health Check
app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date() });
});

// Redirigir raíz a login
app.get("/", (req, res) => {
  res.redirect("/login.html");
});

// Login Endpoint
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Usuario y contraseña requeridos" });
  }

  try {
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    if (user.activo === 0) {
       return res.status(403).json({ error: "Usuario inactivo" });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, rol: user.rol, nombre: user.nombre },
      JWT_SECRET,
      { expiresIn: "12h" }
    );

    res.json({ token, user: { username: user.username, nombre: user.nombre, rol: user.rol } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: List Users
app.get("/api/users", authenticateToken, async (req, res) => {
    if (req.user.rol !== 'GERENTE' && req.user.rol !== 'SISTEMAS') {
        return res.status(403).json({ error: "No autorizado" });
    }
    try {
        const result = await pool.query("SELECT id, username, nombre, rol, activo, created_at FROM users ORDER BY username");
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Middleware de autenticación
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];
  
  // Also check query param (for downloads)
  if (!token && req.query.token) {
      token = req.query.token;
  }

  if (!token) return res.status(401).json({ error: "Acceso denegado" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Token inválido" });
    req.user = user;
    next();
  });
}

// Helper: Get Current Shift
async function getCurrentShift() {
  const shiftRes = await pool.query(`
    SELECT * FROM shifts 
    WHERE 
      (hora_inicio <= CURRENT_TIME AND hora_fin > CURRENT_TIME) 
      OR 
      (hora_inicio > hora_fin AND (CURRENT_TIME >= hora_inicio OR CURRENT_TIME < hora_fin))
    LIMIT 1
  `);
  
  if (shiftRes.rows.length > 0) return shiftRes.rows[0];
  return null;
}

// Endpoint Dashboard
app.get("/api/stations", authenticateToken, async (req, res) => {
  try {
    const currentShift = await getCurrentShift();

    if (!currentShift) {
        return res.status(404).json({ error: "No hay turnos configurados" });
    }

    // 2. Obtener estaciones con estado y encargado del turno actual
    const stationsSql = `
      SELECT 
        s.id as station_id, 
        s.codigo as station_codigo,
        COALESCE(ssa.encargado_nombre, 'SIN ASIGNAR') as encargado_nombre,
        COALESCE(f.codigo_tela, '---') as codigo_tela,
        COALESCE(f.total_fajas, 0) as total_fajas,
        COALESCE(st.siguiente_faja, 1) as siguiente_faja
      FROM stations s
      LEFT JOIN station_state st ON s.id = st.station_id
      LEFT JOIN fabrics f ON st.fabric_id_actual = f.id
      LEFT JOIN station_shift_assignments ssa 
        ON s.id = ssa.station_id 
        AND ssa.shift_id = $1 
        AND ssa.activo = 1
      ORDER BY s.codigo ASC
    `;

    const stationsRes = await pool.query(stationsSql, [currentShift.id]);

    res.json({
      shift: currentShift,
      stations: stationsRes.rows
    });

  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).json({ error: "Error obteniendo datos del dashboard: " + err.message });
  }
});

// GET Station Detail
app.get("/api/stations/:id", authenticateToken, async (req, res) => {
  try {
    const stationId = req.params.id;
    const currentShift = await getCurrentShift();
    if (!currentShift) return res.status(404).json({ error: "No hay turno activo" });

    // Station info
    const stationRes = await pool.query("SELECT * FROM stations WHERE id = $1", [stationId]);
    if (stationRes.rows.length === 0) return res.status(404).json({ error: "Estación no encontrada" });
    const station = stationRes.rows[0];

    // Assignment
    const assignRes = await pool.query(
      "SELECT * FROM station_shift_assignments WHERE station_id = $1 AND shift_id = $2 AND activo = 1",
      [stationId, currentShift.id]
    );
    const assignment = assignRes.rows[0] || {};

    // State & Fabric
    const stateRes = await pool.query(`
      SELECT st.*, f.codigo_tela, f.total_fajas
      FROM station_state st
      LEFT JOIN fabrics f ON st.fabric_id_actual = f.id
      WHERE st.station_id = $1
    `, [stationId]);
    const state = stateRes.rows[0] || {};

    // Open Log?
    const logRes = await pool.query(`
      SELECT * FROM shift_logs 
      WHERE station_id = $1 AND shift_id = $2 AND status = 'ABIERTO'
      ORDER BY id DESC LIMIT 1
    `, [stationId, currentShift.id]);
    const openLog = logRes.rows[0] || null;

    res.json({
      station,
      shift: currentShift,
      assignment,
      state,
      openLog
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET Fabrics List
app.get("/api/fabrics", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM fabrics ORDER BY codigo_tela ASC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET Staff List (Encargados/Ayudantes history) filtered by Shift
app.get("/api/staff", authenticateToken, async (req, res) => {
  try {
    const { shift_id } = req.query;
    let queryParams = [];
    let shiftFilter = "";

    if (shift_id) {
        shiftFilter = "AND shift_id = $1";
        queryParams.push(shift_id);
    }

    // Combine names from assignments and logs to get a list of known staff
    // If shift_id is provided, filter logs and assignments by that shift
    // Note: assignments table has shift_id, logs table has shift_id
    
    const query = `
      SELECT DISTINCT nombre FROM (
        SELECT encargado_nombre as nombre FROM station_shift_assignments WHERE 1=1 ${shiftFilter}
        UNION
        SELECT encargado_nombre as nombre FROM shift_logs WHERE 1=1 ${shiftFilter}
        UNION
        SELECT ayudante_nombre as nombre FROM shift_logs WHERE ayudante_nombre IS NOT NULL ${shiftFilter}
      ) as t
      WHERE nombre IS NOT NULL AND nombre != ''
      ORDER BY nombre ASC
    `;

    const result = await pool.query(query, queryParams);
    res.json(result.rows.map(r => r.nombre));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST Fabric (Add/Update)
app.post("/api/fabrics", authenticateToken, async (req, res) => {
    try {
        const { familia, tipo, total_fajas } = req.body;
        
        if (!familia || !tipo || !total_fajas) {
            return res.status(400).json({ error: "Familia, Tipo y Total Fajas requeridos" });
        }

        // Generate Code: FAMILIA - TIPO (Upper case)
        const codigo_tela = `${familia} - ${tipo}`.toUpperCase();

        // Upsert fabric
        const result = await pool.query(`
            INSERT INTO fabrics (codigo_tela, familia, tipo, total_fajas)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (codigo_tela) 
            DO UPDATE SET total_fajas = $4, familia = $2, tipo = $3
            RETURNING *
        `, [codigo_tela, familia, tipo, total_fajas]);

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// START Turno
app.post("/api/stations/:id/start", authenticateToken, async (req, res) => {
  try {
    const stationId = req.params.id;
    const { ayudante_nombre, encargado_nombre, operador_nombre, fabric_id, faja_inicio, julio } = req.body;
    const currentShift = await getCurrentShift();
    if (!currentShift) return res.status(404).json({ error: "No hay turno activo" });

    // Check existing open log
    const logRes = await pool.query(`
      SELECT * FROM shift_logs 
      WHERE station_id = $1 AND shift_id = $2 AND status = 'ABIERTO'
    `, [stationId, currentShift.id]);

    if (logRes.rows.length > 0) {
      return res.status(400).json({ error: "Ya hay un turno abierto para esta estación" });
    }

    // Determine Encargado
    let finalEncargado = encargado_nombre;
    if (!finalEncargado) {
        // Fallback to assignment
        const assignRes = await pool.query(
          "SELECT * FROM station_shift_assignments WHERE station_id = $1 AND shift_id = $2",
          [stationId, currentShift.id]
        );
        finalEncargado = assignRes.rows[0] ? assignRes.rows[0].encargado_nombre : "DESCONOCIDO";
    }

    // Validate Encargado Name (Must have Name + Surname)
    if (finalEncargado !== "DESCONOCIDO" && (!finalEncargado.trim().includes(' ') || finalEncargado.trim().length < 5)) {
         return res.status(400).json({ error: "El nombre del encargado debe incluir Nombre y Apellido" });
    }

    // Validate Operador Name (If provided, Must have Name + Surname)
    if (operador_nombre && (!operador_nombre.trim().includes(' ') || operador_nombre.trim().length < 5)) {
         return res.status(400).json({ error: "El nombre del Operador debe incluir Nombre y Apellido" });
    }

    // Determine Fabric
    let finalFabricId = fabric_id;
    if (!finalFabricId) {
        // Fallback to current state
        const stateRes = await pool.query("SELECT * FROM station_state WHERE station_id = $1", [stationId]);
        const state = stateRes.rows[0];
        if (!state || !state.fabric_id_actual) {
            return res.status(400).json({ error: "No hay tela asignada y no se proporcionó una" });
        }
        finalFabricId = state.fabric_id_actual;
    } else {
        // Update station state fabric
        await pool.query("UPDATE station_state SET fabric_id_actual = $1 WHERE station_id = $2", [finalFabricId, stationId]);
    }
    
    // Determine Julio Logic
    // If julio is provided, update state. If not, use state.
    let finalJulio = julio ? parseInt(julio, 10) : null;
    
    if (finalJulio) {
        await pool.query("UPDATE station_state SET julio_actual = $1 WHERE station_id = $2", [finalJulio, stationId]);
    } else {
         // Try to get from state if not provided
         const sRes = await pool.query("SELECT julio_actual FROM station_state WHERE station_id = $1", [stationId]);
         if (sRes.rows[0] && sRes.rows[0].julio_actual) {
             finalJulio = sRes.rows[0].julio_actual;
         }
    }

    // Get Faja Start (from state, or override)
    let startFajaVal;
    
    if (faja_inicio) {
        startFajaVal = parseInt(faja_inicio, 10);
        // Update state to reflect this manual override
        await pool.query("UPDATE station_state SET siguiente_faja = $1 WHERE station_id = $2", [startFajaVal, stationId]);
    } else {
        const stateRes = await pool.query("SELECT * FROM station_state WHERE station_id = $1", [stationId]);
        const state = stateRes.rows[0];
        startFajaVal = state.siguiente_faja;
    }

    // Insert Log
    await pool.query(`
      INSERT INTO shift_logs 
      (shift_id, station_id, encargado_nombre, ayudante_nombre, operador_nombre, fabric_id, faja_inicio, julio, status, created_by_user_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ABIERTO', $9)
    `, [
      currentShift.id, 
      stationId, 
      finalEncargado, 
      ayudante_nombre, 
      operador_nombre,
      finalFabricId,
      startFajaVal,
      finalJulio,
      req.user.id
    ]);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET Report Logs (Admin/Gerente)
app.get("/api/admin/logs", authenticateToken, async (req, res) => {
    try {
        if (req.user.rol !== 'GERENTE' && req.user.rol !== 'SISTEMAS') {
            return res.status(403).json({ error: "Acceso no autorizado" });
        }

        const query = `
            SELECT 
                sl.id,
                sl.fecha,
                sh.nombre as turno,
                st.codigo as estacion,
                sl.encargado_nombre,
                sl.ayudante_nombre,
                f.codigo_tela,
                sl.faja_inicio,
                sl.faja_fin,
                sl.inicio_ts,
                sl.fin_ts,
                sl.observaciones,
                sl.status
            FROM shift_logs sl
            JOIN shifts sh ON sl.shift_id = sh.id
            JOIN stations st ON sl.station_id = st.id
            JOIN fabrics f ON sl.fabric_id = f.id
            ORDER BY sl.fecha DESC, sl.inicio_ts DESC
        `;

        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// START Turno
app.post("/api/stations/:id/end", authenticateToken, async (req, res) => {
  try {
    const stationId = req.params.id;
    const { faja_fin, ayudante_nombre, observaciones, estado_urdido } = req.body;
    const currentShift = await getCurrentShift();
    if (!currentShift) return res.status(404).json({ error: "No hay turno activo" });

    // Find open log
    const logRes = await pool.query(`
      SELECT * FROM shift_logs 
      WHERE station_id = $1 AND shift_id = $2 AND status = 'ABIERTO'
      ORDER BY id DESC LIMIT 1
    `, [stationId, currentShift.id]);
    const openLog = logRes.rows[0];

    if (!openLog) {
      return res.status(400).json({ error: "No hay turno abierto para cerrar" });
    }

    // Validation
    let finalFajaFin = faja_fin;
    
    // Si faja_fin es null/undefined, permitimos cerrar sin validar número (útil para cambios de estado sin avance)
    if (finalFajaFin !== null && finalFajaFin !== undefined) {
         if (finalFajaFin < openLog.faja_inicio) {
             return res.status(400).json({ error: `La faja final debe ser >= ${openLog.faja_inicio}` });
         }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Update Log
      await client.query(`
        UPDATE shift_logs 
        SET faja_fin = $1, ayudante_nombre = $2, observaciones = $3, estado_urdido = $4, status = 'CERRADO', fin_ts = NOW()
        WHERE id = $5
      `, [finalFajaFin, ayudante_nombre, observaciones, estado_urdido, openLog.id]);

      // Solo actualizamos el estado de la estación si se reportó faja_fin
      if (finalFajaFin !== null && finalFajaFin !== undefined) {
          // Check if fabric is completed
          const fabricRes = await client.query("SELECT total_fajas FROM fabrics WHERE id = $1", [openLog.fabric_id]);
          const totalFajas = fabricRes.rows[0] ? fabricRes.rows[0].total_fajas : 999999;

          let nextFaja = finalFajaFin + 1;
          let fabricIdActual = openLog.fabric_id;

          // Logic: If we finished the last faja (or more), reset the station for next fabric
          if (finalFajaFin >= totalFajas) {
              nextFaja = 1; // Reset faja counter
              fabricIdActual = null; // Clear fabric assignment
          }

          // Update Station State
          await client.query(`
            UPDATE station_state 
            SET siguiente_faja = $1, fabric_id_actual = $2
            WHERE station_id = $3
          `, [nextFaja, fabricIdActual, stationId]);
      }

      await client.query("COMMIT");
      
      // Calculamos si se completó la tela solo si tenemos datos
      const fabricRes = await client.query("SELECT total_fajas FROM fabrics WHERE id = $1", [openLog.fabric_id]);
      const totalFajas = fabricRes.rows[0] ? fabricRes.rows[0].total_fajas : 999999;
      const isCompleted = (finalFajaFin !== null && finalFajaFin !== undefined) ? (finalFajaFin >= totalFajas) : false;

      res.json({ ok: true, completed: isCompleted });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// prueba rápida
app.get("/api/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT NOW()");
    res.json({ ok: true, time: r.rows[0].now });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auto-update shifts and users on startup
(async () => {
    try {
        // 1. Sync Shifts
        await pool.query(`
            UPDATE shifts SET hora_inicio = '07:00', hora_fin = '15:00' WHERE nombre = 'T1';
            UPDATE shifts SET hora_inicio = '15:00', hora_fin = '23:00' WHERE nombre = 'T2';
            UPDATE shifts SET hora_inicio = '23:00', hora_fin = '07:00' WHERE nombre = 'T3';
        `);
        console.log("Horarios de turnos sincronizados.");

        // 2. Ensure Users Exist (Supervisors & Gerente)
        // Helper to upsert user
        const upsertUser = async (username, password, name, role) => {
            const hash = await bcrypt.hash(password, 10);
            await pool.query(`
                INSERT INTO users (username, password_hash, nombre, rol)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (username) 
                DO UPDATE SET password_hash = $2, nombre = $3, rol = $4
            `, [username, hash, name, role]);
        };

        await upsertUser('super1', 'carpe1', 'Supervisor 1', 'SUPERVISOR');
        await upsertUser('super2', 'carpe2', 'Supervisor 2', 'SUPERVISOR');
        await upsertUser('super3', 'carpe3', 'Supervisor 3', 'SUPERVISOR');
        await upsertUser('gerente', 'gerente123', 'Gerente de Planta', 'GERENTE');
        // Admin backup
        const adminUser = process.env.SEED_ADMIN_USER || "admin";
        const adminPass = process.env.SEED_ADMIN_PASSWORD || "admin123";
        await upsertUser(adminUser, adminPass, 'Administrador', 'SISTEMAS');

        console.log("Usuarios críticos sincronizados.");

        // 3. Ensure Assignments (Supervisors -> Shifts)
        // Get Shift IDs
        const shiftsRes = await pool.query("SELECT id, nombre FROM shifts");
        const shiftsMap = shiftsRes.rows.reduce((acc, r) => (acc[r.nombre] = r.id, acc), {});
        
        // Get Station IDs
        const stationsRes = await pool.query("SELECT id, codigo FROM stations");
        
        // Supervisor Map
        const supervisorMap = {
            "T1": "Supervisor 1",
            "T2": "Supervisor 2",
            "T3": "Supervisor 3"
        };

        if (stationsRes.rows.length > 0 && Object.keys(shiftsMap).length > 0) {
            for (const st of stationsRes.rows) {
                 for (const [shiftName, shiftId] of Object.entries(shiftsMap)) {
                     if (!shiftId) continue;
                     const encargado = supervisorMap[shiftName] || `${st.codigo} - Encargado ${shiftName}`;
                     
                     await pool.query(`
                      INSERT INTO station_shift_assignments (station_id, shift_id, encargado_nombre) 
                      VALUES ($1,$2,$3) 
                      ON CONFLICT (station_id, shift_id) 
                      DO UPDATE SET encargado_nombre = EXCLUDED.encargado_nombre
                    `, [st.id, shiftId, encargado]);
                 }
            }
            console.log("Asignaciones de supervisores sincronizadas.");
        }

    } catch (e) {
        console.error("Error sync startup data", e);
    }
})();

// GET Staff List (Ayudantes, Operadores, etc.)
app.get("/api/staff", authenticateToken, async (req, res) => {
    try {
        // Return unique names from shift_logs (both encargados, ayudantes, and operadores)
        const result = await pool.query(`
            SELECT DISTINCT nombre FROM (
                SELECT encargado_nombre as nombre FROM shift_logs WHERE encargado_nombre IS NOT NULL
                UNION
                SELECT ayudante_nombre as nombre FROM shift_logs WHERE ayudante_nombre IS NOT NULL
                UNION
                SELECT operador_nombre as nombre FROM shift_logs WHERE operador_nombre IS NOT NULL
            ) as t
            ORDER BY nombre
        `);
        res.json(result.rows.map(r => r.nombre));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- REPORT EXPORT START ---

// Helper to get Users data
async function getUsersExportData() {
    const sql = `
        SELECT 
            username, 
            nombre, 
            rol, 
            activo, 
            created_at 
        FROM users 
        ORDER BY username
    `;
    return await pool.query(sql);
}

// Export Users Excel
app.get("/api/admin/export/users/excel", authenticateToken, async (req, res) => {
    if (req.user.rol !== 'GERENTE' && req.user.rol !== 'SISTEMAS') return res.status(403).send("No autorizado");
    
    try {
        const result = await getUsersExportData();
        const users = result.rows;

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Usuarios');

        sheet.columns = [
            { header: 'Usuario', key: 'username', width: 15 },
            { header: 'Nombre', key: 'nombre', width: 25 },
            { header: 'Rol', key: 'rol', width: 15 },
            { header: 'Estado', key: 'estado', width: 10 },
            { header: 'Creado', key: 'created_at', width: 15 }
        ];

        users.forEach(u => {
            sheet.addRow({
                username: u.username,
                nombre: u.nombre || '',
                rol: u.rol,
                estado: u.activo ? 'Activo' : 'Inactivo',
                created_at: u.created_at ? new Date(u.created_at).toLocaleDateString() : ''
            });
        });
        
        sheet.getRow(1).font = { bold: true };

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=usuarios_${new Date().toISOString().split('T')[0]}.xlsx`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (e) {
        console.error(e);
        res.status(500).send("Error generando Excel Usuarios: " + e.message);
    }
});

// Export Users PDF
app.get("/api/admin/export/users/pdf", authenticateToken, async (req, res) => {
    if (req.user.rol !== 'GERENTE' && req.user.rol !== 'SISTEMAS') return res.status(403).send("No autorizado");

    try {
        const result = await getUsersExportData();
        const users = result.rows;

        const doc = new PDFDocument({ margin: 30, size: 'A4' });
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=usuarios_${new Date().toISOString().split('T')[0]}.pdf`);

        doc.pipe(res);

        doc.fontSize(18).text(`Lista de Usuarios`, { align: 'center' });
        doc.fontSize(12).text(`Fecha: ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.moveDown();

        const table = {
            title: "Usuarios Registrados",
            headers: ["Usuario", "Nombre", "Rol", "Estado", "Creado"],
            rows: users.map(u => [
                u.username,
                u.nombre || '',
                u.rol,
                u.activo ? 'Activo' : 'Inactivo',
                u.created_at ? new Date(u.created_at).toLocaleDateString() : ''
            ])
        };

        await doc.table(table, {
            width: 500,
            prepareHeader: () => doc.font("Helvetica-Bold").fontSize(10),
            prepareRow: (row, i) => doc.font("Helvetica").fontSize(10)
        });

        doc.end();

    } catch (e) {
        console.error(e);
        if (!res.headersSent) res.status(500).send("Error generando PDF Usuarios: " + e.message);
    }
});

// Helper to get filtered logs query
async function getExportData(period, dateVal) {
    let whereClause = "";
    let params = [];

    if (period === 'day') {
        whereClause = "WHERE sl.fecha = $1";
        params = [dateVal];
    } else if (period === 'week') {
        // Asumiendo dateVal es un día dentro de la semana, calculamos lunes y domingo
        // We force parsing as YYYY-MM-DD to avoid timezone issues with new Date(string)
        const parts = dateVal.split('-');
        const d = new Date(parts[0], parts[1]-1, parts[2]); // Local time construction
        
        const day = d.getDay(); // 0 (Sun) - 6 (Sat)
        // Monday is 1. If Sunday (0), we go back 6 days. If Mon (1), 0 days.
        const diffToMon = (day === 0 ? -6 : 1) - day;
        
        const monday = new Date(d);
        monday.setDate(d.getDate() + diffToMon);
        
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        
        // Format YYYY-MM-DD manually
        const formatDate = (date) => {
             const y = date.getFullYear();
             const m = String(date.getMonth() + 1).padStart(2, '0');
             const d = String(date.getDate()).padStart(2, '0');
             return `${y}-${m}-${d}`;
        };

        whereClause = "WHERE sl.fecha >= $1 AND sl.fecha <= $2";
        params = [formatDate(monday), formatDate(sunday)];
    } else if (period === 'month') {
        // dateVal es YYYY-MM
        const [year, month] = dateVal.split('-');
        const startDate = `${year}-${month}-01`;
        // Last day of month
        // new Date(year, month, 0) gets the last day of previous month? No.
        // new Date(year, month, 0) -> day 0 of month 'month' (which is index based?)
        // Date constructor (y, m, d): m is 0-11.
        // If we want last day of 'month' (1-12 from string), we do new Date(year, month, 0).
        // e.g. Month 02 (Feb), new Date(2023, 2, 0) is March 0 -> Feb 28.
        const lastDay = new Date(year, month, 0).getDate();
        const endDate = `${year}-${month}-${lastDay}`;
        
        whereClause = "WHERE sl.fecha >= $1 AND sl.fecha <= $2";
        params = [startDate, endDate];
    }

    const sql = `
        SELECT 
            sl.fecha,
            sh.nombre as turno,
            s.codigo as estacion,
            sl.encargado_nombre,
            sl.ayudante_nombre,
            sl.operador_nombre,
            f.codigo_tela,
            sl.faja_inicio,
            sl.faja_fin,
            sl.julio,
            sl.inicio_ts,
            sl.fin_ts,
            sl.observaciones,
            sl.estado_urdido,
            sl.status
        FROM shift_logs sl
        JOIN shifts sh ON sl.shift_id = sh.id
        JOIN stations s ON sl.station_id = s.id
        JOIN fabrics f ON sl.fabric_id = f.id
        ${whereClause}
        ORDER BY sl.fecha DESC, sl.inicio_ts DESC
    `;
    
    return await pool.query(sql, params);
}

// Export Excel
app.get("/api/admin/export/excel", authenticateToken, async (req, res) => {
    if (req.user.rol !== 'GERENTE' && req.user.rol !== 'SISTEMAS') return res.status(403).send("No autorizado");
    
    try {
        const { period, date } = req.query;
        if (!period || !date) return res.status(400).send("Faltan parámetros");

        const result = await getExportData(period, date);
        const logs = result.rows;

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Reporte Producción');

        sheet.columns = [
            { header: 'Fecha', key: 'fecha', width: 12 },
            { header: 'Turno', key: 'turno', width: 10 },
            { header: 'Estación', key: 'estacion', width: 10 },
            { header: 'Encargado', key: 'encargado', width: 20 },
            { header: 'Operador', key: 'operador', width: 20 },
            { header: 'Ayudante', key: 'ayudante', width: 20 },
            { header: 'Tela', key: 'tela', width: 15 },
            { header: 'Faja Inicio', key: 'faja_inicio', width: 10 },
            { header: 'Faja Fin', key: 'faja_fin', width: 10 },
            { header: 'Julio', key: 'julio', width: 10 },
            { header: 'Inicio Turno', key: 'inicio', width: 15 },
            { header: 'Fin Turno', key: 'fin', width: 15 },
            { header: 'Estado Urdido', key: 'estado_urdido', width: 15 },
            { header: 'Status', key: 'status', width: 10 },
            { header: 'Observaciones', key: 'obs', width: 30 },
        ];

        logs.forEach(l => {
            // Helper to format date safely
            const safeDate = (d) => d ? new Date(d).toLocaleDateString() : '';
            const safeTime = (d) => d ? new Date(d).toLocaleTimeString() : '';

            sheet.addRow({
                fecha: safeDate(l.fecha),
                turno: l.turno,
                estacion: l.estacion,
                encargado: l.encargado_nombre,
                operador: l.operador_nombre,
                ayudante: l.ayudante_nombre,
                tela: l.codigo_tela,
                faja_inicio: l.faja_inicio,
                faja_fin: l.faja_fin,
                julio: l.julio,
                inicio: safeTime(l.inicio_ts),
                fin: safeTime(l.fin_ts),
                estado_urdido: l.estado_urdido,
                status: l.status,
                obs: l.observaciones
            });
        });
        
        // Estilos básicos
        sheet.getRow(1).font = { bold: true };

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=reporte_${period}_${date}.xlsx`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (e) {
        console.error(e);
        res.status(500).send("Error generando Excel: " + e.message);
    }
});

// Export PDF
app.get("/api/admin/export/pdf", authenticateToken, async (req, res) => {
    if (req.user.rol !== 'GERENTE' && req.user.rol !== 'SISTEMAS') return res.status(403).send("No autorizado");

    try {
        const { period, date } = req.query;
        if (!period || !date) return res.status(400).send("Faltan parámetros");

        const result = await getExportData(period, date);
        const logs = result.rows;

        const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=reporte_${period}_${date}.pdf`);

        doc.pipe(res);

        doc.fontSize(18).text(`Reporte de Producción (${period})`, { align: 'center' });
        doc.fontSize(12).text(`Fecha/Periodo: ${date}`, { align: 'center' });
        doc.moveDown();

        const table = {
            title: "Registros",
            headers: ["Fecha", "Turno", "Est.", "Encargado", "Tela", "F. Ini", "F. Fin", "Julio", "Estado"],
            rows: logs.map(l => [
                new Date(l.fecha).toLocaleDateString(),
                l.turno,
                l.estacion,
                l.encargado_nombre || '',
                l.codigo_tela || '',
                l.faja_inicio,
                l.faja_fin || '-',
                l.julio || '-',
                l.status
            ])
        };

        // Simple table rendering logic if not using pdfkit-table (but we installed it)
        // Wait, 'pdfkit-table' extends PDFDocument? 
        // Usage: const doc = new PDFDocument(); 
        // But to use table, usually: 
        // const PDFDocument = require("pdfkit-table");
        // const doc = new PDFDocument(...)
        // doc.table(table, options);
        // I imported it as PDFDocument, so it should work.

        await doc.table(table, {
            width: 750,
            prepareHeader: () => doc.font("Helvetica-Bold").fontSize(10),
            prepareRow: (row, i) => doc.font("Helvetica").fontSize(10)
        });

        doc.end();

    } catch (e) {
        console.error(e);
        if (!res.headersSent) res.status(500).send("Error generando PDF: " + e.message);
    }
});

// --- REPORT EXPORT END ---

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
