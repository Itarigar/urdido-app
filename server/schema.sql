PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS stations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE,
  hora_inicio TEXT NOT NULL, -- "06:00"
  hora_fin TEXT NOT NULL     -- "14:00"
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nombre TEXT NOT NULL,
  rol TEXT NOT NULL CHECK (rol IN ('SUPERVISOR','GERENTE','SISTEMAS')),
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS station_shift_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL,
  shift_id INTEGER NOT NULL,
  encargado_nombre TEXT NOT NULL,
  activo INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (station_id) REFERENCES stations(id),
  FOREIGN KEY (shift_id) REFERENCES shifts(id),
  UNIQUE (station_id, shift_id)
);

CREATE TABLE IF NOT EXISTS fabrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo_tela TEXT NOT NULL UNIQUE,
  descripcion TEXT,
  total_fajas INTEGER NOT NULL CHECK (total_fajas > 0)
);

CREATE TABLE IF NOT EXISTS station_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL,
  fabric_id INTEGER NOT NULL,
  orden INTEGER NOT NULL,
  activa INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (station_id) REFERENCES stations(id),
  FOREIGN KEY (fabric_id) REFERENCES fabrics(id)
);

CREATE TABLE IF NOT EXISTS station_state (
  station_id INTEGER PRIMARY KEY,
  fabric_id_actual INTEGER,
  siguiente_faja INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (station_id) REFERENCES stations(id),
  FOREIGN KEY (fabric_id_actual) REFERENCES fabrics(id)
);

CREATE TABLE IF NOT EXISTS shift_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,          -- "YYYY-MM-DD"
  shift_id INTEGER NOT NULL,
  station_id INTEGER NOT NULL,
  encargado_nombre TEXT NOT NULL,
  ayudante_nombre TEXT,
  fabric_id INTEGER NOT NULL,
  faja_inicio INTEGER NOT NULL,
  faja_fin INTEGER,
  inicio_ts TEXT NOT NULL DEFAULT (datetime('now')),
  fin_ts TEXT,
  observaciones TEXT,
  status TEXT NOT NULL CHECK (status IN ('ABIERTO','CERRADO')),
  created_by_user_id INTEGER NOT NULL,
  FOREIGN KEY (shift_id) REFERENCES shifts(id),
  FOREIGN KEY (station_id) REFERENCES stations(id),
  FOREIGN KEY (fabric_id) REFERENCES fabrics(id),
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);
