require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("./db");
const bcrypt = require("bcryptjs");

const schemaPath = path.join(__dirname, "schema.sql");

async function seed() {
  const client = await pool.connect();
  try {
    console.log("Iniciando semilla...");

    // Leer y ejecutar schema
    console.log("Ejecutando esquema SQL...");
    const schemaSql = fs.readFileSync(schemaPath, "utf8");
    await client.query(schemaSql);

    // Helpers
    const insertStation = async (codigo) => {
      await client.query("INSERT INTO stations (codigo) VALUES ($1) ON CONFLICT (codigo) DO NOTHING", [codigo]);
    };
    const insertShift = async (nombre, inicio, fin) => {
      await client.query("INSERT INTO shifts (nombre, hora_inicio, hora_fin) VALUES ($1,$2,$3) ON CONFLICT (nombre) DO NOTHING", [nombre, inicio, fin]);
    };
    const insertUser = async (username, password, nombre, rol) => {
      const password_hash = bcrypt.hashSync(password, 10);
      await client.query("INSERT INTO users (username, password_hash, nombre, rol) VALUES ($1,$2,$3,$4) ON CONFLICT (username) DO NOTHING", [username, password_hash, nombre, rol]);
    };

    // 1. Turnos
    console.log("Insertando turnos...");
    await insertShift("T1", "06:00", "14:00");
    await insertShift("T2", "14:00", "22:00");
    await insertShift("T3", "22:00", "06:00");

    // 2. Estaciones
    console.log("Insertando estaciones...");
    await insertStation("#1");
    await insertStation("#6");
    await insertStation("#8");

    // 3. Usuarios
    console.log("Insertando usuarios...");
    await insertUser("super1", "1234", "Supervisor 1", "SUPERVISOR");
    await insertUser("super2", "1234", "Supervisor 2", "SUPERVISOR");
    await insertUser("super3", "1234", "Supervisor 3", "SUPERVISOR");
    await insertUser("gerente", "1234", "Gerente", "GERENTE");
    await insertUser("sistemas", "1234", "Sistemas", "SISTEMAS");

    // 4. Asignaciones (Todos contra todos)
    console.log("Generando asignaciones...");
    const { rows: stations } = await client.query("SELECT id, codigo FROM stations");
    const { rows: shifts } = await client.query("SELECT id, nombre FROM shifts");

    for (const st of stations) {
      for (const sh of shifts) {
        const encargado = `${st.codigo} - Encargado ${sh.nombre}`;
        await client.query(
          "INSERT INTO station_shift_assignments (station_id, shift_id, encargado_nombre) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
          [st.id, sh.id, encargado]
        );
      }
    }

    // 5. Telas
    console.log("Insertando telas...");
    await client.query("INSERT INTO fabrics (codigo_tela, descripcion, total_fajas) VALUES ($1,$2,$3) ON CONFLICT (codigo_tela) DO NOTHING", ["T-100", "Tela ejemplo 100", 80]);
    await client.query("INSERT INTO fabrics (codigo_tela, descripcion, total_fajas) VALUES ($1,$2,$3) ON CONFLICT (codigo_tela) DO NOTHING", ["T-200", "Tela ejemplo 200", 60]);
    await client.query("INSERT INTO fabrics (codigo_tela, descripcion, total_fajas) VALUES ($1,$2,$3) ON CONFLICT (codigo_tela) DO NOTHING", ["T-300", "Tela ejemplo 300", 100]);

    // Obtener IDs de telas
    const { rows: fabrics } = await client.query("SELECT id, codigo_tela FROM fabrics");
    const fabricMap = fabrics.reduce((acc, r) => (acc[r.codigo_tela] = r.id, acc), {});

    // 6. Cola por estación
    console.log("Insertando colas...");
    for (const st of stations) {
      // Limpiar cola existente para evitar duplicados en re-seed (opcional, aquí solo insertamos si no existe lógica compleja)
      // Como 'orden' no es unique junto con station_id, podría duplicarse si corremos seed varias veces.
      // Para simplificar: borramos cola anterior de estas estaciones.
      await client.query("DELETE FROM station_queue WHERE station_id = $1", [st.id]);
      
      await client.query("INSERT INTO station_queue (station_id, fabric_id, orden) VALUES ($1,$2,$3)", [st.id, fabricMap["T-100"], 1]);
      await client.query("INSERT INTO station_queue (station_id, fabric_id, orden) VALUES ($1,$2,$3)", [st.id, fabricMap["T-200"], 2]);
      await client.query("INSERT INTO station_queue (station_id, fabric_id, orden) VALUES ($1,$2,$3)", [st.id, fabricMap["T-300"], 3]);
    }

    // 7. Estado inicial (station_state)
    console.log("Inicializando estado...");
    for (const st of stations) {
      const res = await client.query(`
        SELECT fabric_id FROM station_queue 
        WHERE station_id = $1 AND activa = 1 
        ORDER BY orden ASC LIMIT 1
      `, [st.id]);
      
      if (res.rows.length > 0) {
        const first = res.rows[0];
        // Upsert en Postgres
        await client.query(`
          INSERT INTO station_state (station_id, fabric_id_actual, siguiente_faja)
          VALUES ($1, $2, 1)
          ON CONFLICT (station_id) 
          DO UPDATE SET fabric_id_actual = EXCLUDED.fabric_id_actual, siguiente_faja = 1
        `, [st.id, first.fabric_id]);
      }
    }

    console.log("✅ Seed completado correctamente.");
  } catch (err) {
    console.error("❌ Error en seed:", err);
  } finally {
    client.release();
    pool.end(); // Cerrar pool para terminar proceso
  }
}

seed();
