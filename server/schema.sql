CREATE TABLE IF NOT EXISTS stations (
  id SERIAL PRIMARY KEY,
  codigo TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE,
  hora_inicio TEXT NOT NULL,
  hora_fin TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nombre TEXT NOT NULL,
  rol TEXT NOT NULL CHECK (rol IN ('SUPERVISOR','GERENTE','SISTEMAS')),
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS station_shift_assignments (
  id SERIAL PRIMARY KEY,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  encargado_nombre TEXT NOT NULL,
  activo INTEGER NOT NULL DEFAULT 1,
  UNIQUE (station_id, shift_id)
);

CREATE TABLE IF NOT EXISTS fabrics (
  id SERIAL PRIMARY KEY,
  codigo_tela TEXT NOT NULL UNIQUE,
  descripcion TEXT,
  total_fajas INTEGER NOT NULL CHECK (total_fajas > 0)
);

CREATE TABLE IF NOT EXISTS station_queue (
  id SERIAL PRIMARY KEY,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  fabric_id INTEGER NOT NULL REFERENCES fabrics(id),
  orden INTEGER NOT NULL,
  activa INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS station_state (
  station_id INTEGER PRIMARY KEY REFERENCES stations(id),
  fabric_id_actual INTEGER REFERENCES fabrics(id),
  siguiente_faja INTEGER,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS shift_logs (
  id SERIAL PRIMARY KEY,
  fecha TEXT NOT NULL,
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  station_id INTEGER NOT NULL REFERENCES stations(id),
  encargado_nombre TEXT NOT NULL,
  ayudante_nombre TEXT,
  fabric_id INTEGER NOT NULL REFERENCES fabrics(id),
  faja_inicio INTEGER NOT NULL,
  faja_fin INTEGER,
  inicio_ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fin_ts TIMESTAMP,
  observaciones TEXT,
  status TEXT NOT NULL CHECK (status IN ('ABIERTO','CERRADO')),
  created_by_user_id INTEGER NOT NULL REFERENCES users(id)
);
