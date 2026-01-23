const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const dbPath = path.join(__dirname, "db.sqlite");
const schemaPath = path.join(__dirname, "schema.sql");

if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
const db = new Database(dbPath);

db.exec(fs.readFileSync(schemaPath, "utf8"));

// Helpers
function insertStation(codigo) {
  db.prepare("INSERT INTO stations (codigo) VALUES (?)").run(codigo);
}
function insertShift(nombre, inicio, fin) {
  db.prepare("INSERT INTO shifts (nombre, hora_inicio, hora_fin) VALUES (?,?,?)").run(nombre, inicio, fin);
}
function insertUser(username, password, nombre, rol) {
  const password_hash = bcrypt.hashSync(password, 10);
  db.prepare("INSERT INTO users (username, password_hash, nombre, rol) VALUES (?,?,?,?)")
    .run(username, password_hash, nombre, rol);
}

// Turnos ejemplo (ajusta si tu planta maneja otros)
insertShift("T1", "06:00", "14:00");
insertShift("T2", "14:00", "22:00");
insertShift("T3", "22:00", "06:00");

// Estaciones / botones
insertStation("#1");
insertStation("#6");
insertStation("#8");

// Usuarios (5 accesos)
insertUser("super1", "1234", "Supervisor 1", "SUPERVISOR");
insertUser("super2", "1234", "Supervisor 2", "SUPERVISOR");
insertUser("super3", "1234", "Supervisor 3", "SUPERVISOR");
insertUser("gerente", "1234", "Gerente", "GERENTE");
insertUser("sistemas", "1234", "Sistemas", "SISTEMAS");

// Asignación por defecto de encargado según turno (ejemplo)
const stations = db.prepare("SELECT id, codigo FROM stations").all();
const shifts = db.prepare("SELECT id, nombre FROM shifts").all();

for (const st of stations) {
  for (const sh of shifts) {
    const encargado = `${st.codigo} - Encargado ${sh.nombre}`;
    db.prepare(
      "INSERT INTO station_shift_assignments (station_id, shift_id, encargado_nombre) VALUES (?,?,?)"
    ).run(st.id, sh.id, encargado);
  }
}

// Crear telas ejemplo
db.prepare("INSERT INTO fabrics (codigo_tela, descripcion, total_fajas) VALUES (?,?,?)")
  .run("T-100", "Tela ejemplo 100", 80);
db.prepare("INSERT INTO fabrics (codigo_tela, descripcion, total_fajas) VALUES (?,?,?)")
  .run("T-200", "Tela ejemplo 200", 60);
db.prepare("INSERT INTO fabrics (codigo_tela, descripcion, total_fajas) VALUES (?,?,?)")
  .run("T-300", "Tela ejemplo 300", 100);

const fabricMap = db.prepare("SELECT id, codigo_tela FROM fabrics").all()
  .reduce((acc, r) => (acc[r.codigo_tela] = r.id, acc), {});

// Cola por estación (ejemplo)
for (const st of stations) {
  db.prepare("INSERT INTO station_queue (station_id, fabric_id, orden) VALUES (?,?,?)").run(st.id, fabricMap["T-100"], 1);
  db.prepare("INSERT INTO station_queue (station_id, fabric_id, orden) VALUES (?,?,?)").run(st.id, fabricMap["T-200"], 2);
  db.prepare("INSERT INTO station_queue (station_id, fabric_id, orden) VALUES (?,?,?)").run(st.id, fabricMap["T-300"], 3);
}

// station_state inicial: toma la primera tela de la cola y faja 1
for (const st of stations) {
  const first = db.prepare(`
    SELECT q.fabric_id
    FROM station_queue q
    WHERE q.station_id = ? AND q.activa = 1
    ORDER BY q.orden ASC
    LIMIT 1
  `).get(st.id);

  db.prepare(`
    INSERT INTO station_state (station_id, fabric_id_actual, siguiente_faja)
    VALUES (?,?,?)
  `).run(st.id, first.fabric_id, 1);
}

console.log("DB creada y sembrada en server/db.sqlite");
console.log("Usuarios: super1/super2/super3/gerente/sistemas con password 1234");
