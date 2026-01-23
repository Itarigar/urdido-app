const path = require("path");
const express = require("express");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const db = new Database(path.join(__dirname, "db.sqlite"));
db.pragma("foreign_keys = ON");

const JWT_SECRET = "cambia-esto-en-produccion";
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// --------- Helpers de tiempo/turno ----------
function pad2(n) { return String(n).padStart(2, "0"); }
function getLocalDateISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}
function getLocalTimeHHMM() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
// Turno actual basado en shifts (soporta turno nocturno que cruza medianoche)
function getCurrentShift() {
  const shifts = db.prepare("SELECT * FROM shifts").all();
  const now = getLocalTimeHHMM();
  const nowMin = timeToMinutes(now);

  for (const sh of shifts) {
    const startMin = timeToMinutes(sh.hora_inicio);
    const endMin = timeToMinutes(sh.hora_fin);

    // Normal: 06:00-14:00
    if (startMin < endMin) {
      if (nowMin >= startMin && nowMin < endMin) return sh;
    } else {
      // Cruza medianoche: 22:00-06:00
      if (nowMin >= startMin || nowMin < endMin) return sh;
    }
  }
  // Si algo falla, retorna el primero
  return shifts[0];
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No autenticado" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.rol)) {
      return res.status(403).json({ error: "Sin permisos" });
    }
    next();
  };
}

// --------- Auth ----------
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Faltan credenciales" });

  const user = db.prepare("SELECT * FROM users WHERE username = ? AND activo = 1").get(username);
  if (!user) return res.status(401).json({ error: "Usuario o contraseña incorrectos" });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Usuario o contraseña incorrectos" });

  const token = jwt.sign(
    { id: user.id, nombre: user.nombre, rol: user.rol, username: user.username },
    JWT_SECRET,
    { expiresIn: "12h" }
  );

  res.json({ token, user: { id: user.id, nombre: user.nombre, rol: user.rol, username: user.username } });
});

// --------- Dashboard: estaciones ----------
app.get("/api/stations", requireAuth, (req, res) => {
  const shift = getCurrentShift();

  const rows = db.prepare(`
    SELECT
      s.id AS station_id,
      s.codigo AS station_codigo,
      st.fabric_id_actual,
      st.siguiente_faja,
      f.codigo_tela,
      f.total_fajas,
      a.encargado_nombre
    FROM stations s
    JOIN station_state st ON st.station_id = s.id
    JOIN fabrics f ON f.id = st.fabric_id_actual
    LEFT JOIN station_shift_assignments a
      ON a.station_id = s.id AND a.shift_id = ? AND a.activo = 1
    ORDER BY s.codigo
  `).all(shift.id);

  res.json({
    shift: { id: shift.id, nombre: shift.nombre, hora_inicio: shift.hora_inicio, hora_fin: shift.hora_fin },
    stations: rows
  });
});

// --------- Detalle estación ----------
app.get("/api/stations/:id", requireAuth, (req, res) => {
  const stationId = Number(req.params.id);
  const shift = getCurrentShift();

  const station = db.prepare("SELECT * FROM stations WHERE id = ?").get(stationId);
  if (!station) return res.status(404).json({ error: "Estación no existe" });

  const state = db.prepare(`
    SELECT st.station_id, st.fabric_id_actual, st.siguiente_faja, f.codigo_tela, f.descripcion, f.total_fajas
    FROM station_state st
    JOIN fabrics f ON f.id = st.fabric_id_actual
    WHERE st.station_id = ?
  `).get(stationId);

  const assignment = db.prepare(`
    SELECT encargado_nombre
    FROM station_shift_assignments
    WHERE station_id = ? AND shift_id = ? AND activo = 1
  `).get(stationId, shift.id);

  const openLog = db.prepare(`
    SELECT *
    FROM shift_logs
    WHERE station_id = ? AND shift_id = ? AND status = 'ABIERTO'
    ORDER BY id DESC LIMIT 1
  `).get(stationId, shift.id);

  res.json({
    station,
    shift,
    assignment: assignment || { encargado_nombre: "SIN ASIGNAR" },
    state,
    openLog: openLog || null
  });
});

// --------- Iniciar turno ----------
app.post("/api/stations/:id/start", requireAuth, (req, res) => {
  const stationId = Number(req.params.id);
  const shift = getCurrentShift();
  const fecha = getLocalDateISO();

  const station = db.prepare("SELECT * FROM stations WHERE id = ?").get(stationId);
  if (!station) return res.status(404).json({ error: "Estación no existe" });

  const existing = db.prepare(`
    SELECT id FROM shift_logs
    WHERE station_id = ? AND shift_id = ? AND status = 'ABIERTO'
    ORDER BY id DESC LIMIT 1
  `).get(stationId, shift.id);
  if (existing) return res.status(409).json({ error: "Ya hay un turno ABIERTO en esta estación" });

  const state = db.prepare("SELECT * FROM station_state WHERE station_id = ?").get(stationId);
  if (!state || !state.fabric_id_actual || !state.siguiente_faja) {
    return res.status(500).json({ error: "Estado de estación incompleto" });
  }

  const assignment = db.prepare(`
    SELECT encargado_nombre
    FROM station_shift_assignments
    WHERE station_id = ? AND shift_id = ? AND activo = 1
  `).get(stationId, shift.id);

  const encargado = assignment?.encargado_nombre || "SIN ASIGNAR";

  const infoFabric = db.prepare("SELECT total_fajas FROM fabrics WHERE id = ?").get(state.fabric_id_actual);
  if (!infoFabric) return res.status(500).json({ error: "Tela actual no existe" });

  if (state.siguiente_faja < 1 || state.siguiente_faja > infoFabric.total_fajas) {
    return res.status(400).json({ error: "siguiente_faja fuera de rango para la tela actual" });
  }

  const stmt = db.prepare(`
    INSERT INTO shift_logs
      (fecha, shift_id, station_id, encargado_nombre, ayudante_nombre, fabric_id, faja_inicio, status, created_by_user_id)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, 'ABIERTO', ?)
  `);
  const ayudante = (req.body?.ayudante_nombre || "").trim() || null;

  const result = stmt.run(
    fecha,
    shift.id,
    stationId,
    encargado,
    ayudante,
    state.fabric_id_actual,
    state.siguiente_faja,
    req.user.id
  );

  res.json({ ok: true, log_id: result.lastInsertRowid });
});

// --------- Terminar turno ----------
app.post("/api/stations/:id/end", requireAuth, (req, res) => {
  const stationId = Number(req.params.id);
  const shift = getCurrentShift();

  const { faja_fin, ayudante_nombre, observaciones } = req.body || {};
  const fajaFinNum = Number(faja_fin);

  if (!Number.isFinite(fajaFinNum)) return res.status(400).json({ error: "faja_fin inválida" });

  const openLog = db.prepare(`
    SELECT *
    FROM shift_logs
    WHERE station_id = ? AND shift_id = ? AND status = 'ABIERTO'
    ORDER BY id DESC LIMIT 1
  `).get(stationId, shift.id);

  if (!openLog) return res.status(404).json({ error: "No hay turno ABIERTO para cerrar" });

  const fabric = db.prepare("SELECT * FROM fabrics WHERE id = ?").get(openLog.fabric_id);
  if (!fabric) return res.status(500).json({ error: "Tela del log no existe" });

  if (fajaFinNum < openLog.faja_inicio) {
    return res.status(400).json({ error: `faja_fin no puede ser menor que faja_inicio (${openLog.faja_inicio})` });
  }

  // Normalizamos: no permitir > total_fajas (si prefieres permitir, cambia la regla)
  if (fajaFinNum > fabric.total_fajas) {
    return res.status(400).json({ error: `faja_fin no puede exceder total_fajas (${fabric.total_fajas})` });
  }

  const tx = db.transaction(() => {
    // Cerrar log
    db.prepare(`
      UPDATE shift_logs
      SET faja_fin = ?, fin_ts = datetime('now'), observaciones = ?, ayudante_nombre = ?, status = 'CERRADO'
      WHERE id = ?
    `).run(
      fajaFinNum,
      (observaciones || "").trim() || null,
      (ayudante_nombre || "").trim() || openLog.ayudante_nombre || null,
      openLog.id
    );

    // Calcular siguiente estado
    let nextFabricId = openLog.fabric_id;
    let nextFaja = fajaFinNum + 1;

    if (fajaFinNum >= fabric.total_fajas) {
      // Termina la tela -> pasar a siguiente en cola
      const currentQueue = db.prepare(`
        SELECT q.id, q.orden
        FROM station_queue q
        WHERE q.station_id = ? AND q.fabric_id = ? AND q.activa = 1
        ORDER BY q.orden ASC
        LIMIT 1
      `).get(stationId, openLog.fabric_id);

      // Desactivar la actual (completada)
      if (currentQueue) {
        db.prepare(`UPDATE station_queue SET activa = 0 WHERE id = ?`).run(currentQueue.id);
      }

      const nextQueue = db.prepare(`
        SELECT q.fabric_id
        FROM station_queue q
        WHERE q.station_id = ? AND q.activa = 1
        ORDER BY q.orden ASC
        LIMIT 1
      `).get(stationId);

      if (!nextQueue) {
        // No hay más telas
        db.prepare(`
          UPDATE station_state
          SET fabric_id_actual = ?, siguiente_faja = ?, updated_at = datetime('now')
          WHERE station_id = ?
        `).run(openLog.fabric_id, fabric.total_fajas, stationId);
        return { finishedAll: true };
      }

      nextFabricId = nextQueue.fabric_id;
      nextFaja = 1;
    }

    db.prepare(`
      UPDATE station_state
      SET fabric_id_actual = ?, siguiente_faja = ?, updated_at = datetime('now')
      WHERE station_id = ?
    `).run(nextFabricId, nextFaja, stationId);

    return { finishedAll: false, nextFabricId, nextFaja };
  });

  const result = tx();
  res.json({ ok: true, result });
});

// --------- Cambiar encargado por turno (solo GERENTE/SISTEMAS) ----------
app.put("/api/stations/:id/assignment", requireAuth, requireRole("GERENTE", "SISTEMAS"), (req, res) => {
  const stationId = Number(req.params.id);
  const shiftId = Number(req.body?.shift_id);
  const encargado_nombre = (req.body?.encargado_nombre || "").trim();

  if (!stationId || !shiftId || !encargado_nombre) return res.status(400).json({ error: "Datos incompletos" });

  const exists = db.prepare(`
    SELECT id FROM station_shift_assignments
    WHERE station_id = ? AND shift_id = ?
  `).get(stationId, shiftId);

  if (exists) {
    db.prepare(`
      UPDATE station_shift_assignments
      SET encargado_nombre = ?, activo = 1
      WHERE id = ?
    `).run(encargado_nombre, exists.id);
  } else {
    db.prepare(`
      INSERT INTO station_shift_assignments (station_id, shift_id, encargado_nombre)
      VALUES (?,?,?)
    `).run(stationId, shiftId, encargado_nombre);
  }

  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
