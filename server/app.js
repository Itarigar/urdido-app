require("dotenv").config();

const express = require("express");
const path = require("path");
const pool = require("./db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

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
      { id: user.id, username: user.username, rol: user.rol },
      JWT_SECRET,
      { expiresIn: "12h" }
    );

    res.json({ 
      token, 
      user: { 
        id: user.id, 
        username: user.username, 
        nombre: user.nombre, 
        rol: user.rol 
      } 
    });

  } catch (err) {
    console.error("Login error:", err);
    // Mostrar detalle del error para depuración
    res.status(500).json({ error: "Error en el servidor: " + err.message });
  }
});

// Middleware de autenticación
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

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

  // Fallback
  const fallback = await pool.query("SELECT * FROM shifts ORDER BY id ASC LIMIT 1");
  return fallback.rows[0];
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

// GET Staff List (Encargados/Ayudantes history)
app.get("/api/staff", authenticateToken, async (req, res) => {
  try {
    // Combine names from assignments and logs to get a list of known staff
    const result = await pool.query(`
      SELECT DISTINCT nombre FROM (
        SELECT encargado_nombre as nombre FROM station_shift_assignments
        UNION
        SELECT encargado_nombre as nombre FROM shift_logs
        UNION
        SELECT ayudante_nombre as nombre FROM shift_logs WHERE ayudante_nombre IS NOT NULL
      ) as t
      WHERE nombre IS NOT NULL AND nombre != ''
      ORDER BY nombre ASC
    `);
    res.json(result.rows.map(r => r.nombre));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// START Turno
app.post("/api/stations/:id/start", authenticateToken, async (req, res) => {
  try {
    const stationId = req.params.id;
    const { ayudante_nombre, encargado_nombre, fabric_id } = req.body;
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
        // If fabric changed, we might need to update station_state or just use it for this log?
        // Usually, changing fabric implies updating the station state.
        // Let's update the station state fabric if it's different.
        await pool.query("UPDATE station_state SET fabric_id_actual = $1 WHERE station_id = $2", [finalFabricId, stationId]);
    }
    
    // Get Faja Start (from state, after potential fabric update? 
    // If fabric changed, maybe faja should reset? 
    // For now, let's assume faja continues from station_state.siguiente_faja
    const stateRes = await pool.query("SELECT * FROM station_state WHERE station_id = $1", [stationId]);
    const state = stateRes.rows[0];

    // Insert Log
    await pool.query(`
      INSERT INTO shift_logs 
      (shift_id, station_id, encargado_nombre, ayudante_nombre, fabric_id, faja_inicio, status, created_by_user_id)
      VALUES ($1, $2, $3, $4, $5, $6, 'ABIERTO', $7)
    `, [
      currentShift.id, 
      stationId, 
      finalEncargado, 
      ayudante_nombre, 
      finalFabricId, 
      state.siguiente_faja,
      req.user.id
    ]);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// END Turno
app.post("/api/stations/:id/end", authenticateToken, async (req, res) => {
  try {
    const stationId = req.params.id;
    const { faja_fin, ayudante_nombre, observaciones } = req.body;
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
    if (faja_fin < openLog.faja_inicio) {
      return res.status(400).json({ error: `La faja final debe ser >= ${openLog.faja_inicio}` });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Update Log
      await client.query(`
        UPDATE shift_logs 
        SET faja_fin = $1, ayudante_nombre = $2, observaciones = $3, status = 'CERRADO', fin_ts = NOW()
        WHERE id = $4
      `, [faja_fin, ayudante_nombre, observaciones, openLog.id]);

      // Update Station State
      await client.query(`
        UPDATE station_state 
        SET siguiente_faja = $1 
        WHERE station_id = $2
      `, [faja_fin + 1, stationId]);

      await client.query("COMMIT");
      res.json({ ok: true });
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

app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
});
