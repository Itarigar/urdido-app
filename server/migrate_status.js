
require("dotenv").config();
const pool = require("./db");

async function migrate() {
  try {
    console.log("Agregando columna estado_urdido a shift_logs...");
    await pool.query("ALTER TABLE shift_logs ADD COLUMN IF NOT EXISTS estado_urdido TEXT");
    console.log("Migración completada.");
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

migrate();
