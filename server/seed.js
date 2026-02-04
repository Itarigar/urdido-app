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

    const insertUser = async (username, password, nombre, rol) => {
      const password_hash = bcrypt.hashSync(password, 10);
      await client.query(`
        INSERT INTO users (username, password_hash, nombre, rol) 
        VALUES ($1,$2,$3,$4) 
        ON CONFLICT (username) 
        DO UPDATE SET password_hash = $2, nombre = $3, rol = $4
      `, [username, password_hash, nombre, rol]);
    };

    // 1. Turnos
    console.log("Insertando turnos...");
    // Usamos ON CONFLICT DO UPDATE para asegurar que los horarios se actualicen si ya existen
    const insertShift = async (nombre, inicio, fin) => {
      await client.query(`
        INSERT INTO shifts (nombre, hora_inicio, hora_fin) 
        VALUES ($1,$2,$3) 
        ON CONFLICT (nombre) 
        DO UPDATE SET hora_inicio = EXCLUDED.hora_inicio, hora_fin = EXCLUDED.hora_fin
      `, [nombre, inicio, fin]);
    };

    await insertShift("T1", "07:00", "15:00");
    await insertShift("T2", "15:00", "23:00");
    await insertShift("T3", "23:00", "07:00");

    // 2. Estaciones
    console.log("Insertando estaciones...");
    await insertStation("#1");
    await insertStation("#6");
    await insertStation("#8");

    // 3. Usuarios (Desde variables de entorno o valores por defecto seguros)
    console.log("Insertando usuarios...");
    const adminUser = process.env.SEED_ADMIN_USER || "admin";
    const adminPass = process.env.SEED_ADMIN_PASSWORD || "admin123";
    
    // Usuario Sistemas (Administrador)
    await insertUser(adminUser, adminPass, "Administrador", "SISTEMAS");

    // Usuario Gerente
    await insertUser("gerente", "gerente123", "Gerente de Planta", "GERENTE");
    
    // Usuarios Supervisores
    // super1 -> carpe1
    await insertUser("super1", "carpe1", "Supervisor 1", "SUPERVISOR");
    // super2 -> carpe2
    await insertUser("super2", "carpe2", "Supervisor 2", "SUPERVISOR");
    // super3 -> carpe3
    await insertUser("super3", "carpe3", "Supervisor 3", "SUPERVISOR");

    // 4. Asignaciones (Supervisores específicos por turno)
    console.log("Generando asignaciones...");
    const { rows: stations } = await client.query("SELECT id, codigo FROM stations");
    const { rows: shifts } = await client.query("SELECT id, nombre FROM shifts");
    
    // Mapa de supervisores por nombre de turno
    const supervisorMap = {
        "T1": "Supervisor 1",
        "T2": "Supervisor 2",
        "T3": "Supervisor 3"
    };

    for (const st of stations) {
      for (const sh of shifts) {
        // Asignar el supervisor correspondiente al turno, o un genérico si no coincide
        const encargado = supervisorMap[sh.nombre] || `${st.codigo} - Encargado ${sh.nombre}`;
        
        // Usamos UPSERT para actualizar si ya existe (para corregir asignaciones antiguas)
        await client.query(`
          INSERT INTO station_shift_assignments (station_id, shift_id, encargado_nombre) 
          VALUES ($1,$2,$3) 
          ON CONFLICT (station_id, shift_id) 
          DO UPDATE SET encargado_nombre = EXCLUDED.encargado_nombre
        `, [st.id, sh.id, encargado]);
      }
    }

    // 5. Telas
    console.log("Insertando telas...");
    // Update or Insert fabrics with correct columns (familia, tipo)
    // Note: seed fabrics might be placeholders. We'll assign them valid families.
    
    const insertFabric = async (codigo, desc, familia, tipo, fajas) => {
         await client.query(`
            INSERT INTO fabrics (codigo_tela, descripcion, familia, tipo, total_fajas) 
            VALUES ($1, $2, $3, $4, $5) 
            ON CONFLICT (codigo_tela) 
            DO UPDATE SET total_fajas = $5, familia = $3, tipo = $4
         `, [codigo, desc, familia, tipo, fajas]);
    };

    await insertFabric("COBERTORES - T100", "Tela ejemplo 100", "COBERTORES", "T100", 80);
    await insertFabric("JERGAS - T200", "Tela ejemplo 200", "JERGAS", "T200", 60);
    await insertFabric("COBERTORES - T300", "Tela ejemplo 300", "COBERTORES", "T300", 100);

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
      
      if (fabricMap["COBERTORES - T100"]) await client.query("INSERT INTO station_queue (station_id, fabric_id, orden) VALUES ($1,$2,$3)", [st.id, fabricMap["COBERTORES - T100"], 1]);
      if (fabricMap["JERGAS - T200"]) await client.query("INSERT INTO station_queue (station_id, fabric_id, orden) VALUES ($1,$2,$3)", [st.id, fabricMap["JERGAS - T200"], 2]);
      if (fabricMap["COBERTORES - T300"]) await client.query("INSERT INTO station_queue (station_id, fabric_id, orden) VALUES ($1,$2,$3)", [st.id, fabricMap["COBERTORES - T300"], 3]);
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
