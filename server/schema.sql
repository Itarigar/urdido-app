-- 1. Limpieza (DROP en orden correcto para evitar errores de llaves foráneas)
DROP TABLE IF EXISTS shift_logs CASCADE;
DROP TABLE IF EXISTS station_state CASCADE;
DROP TABLE IF EXISTS station_queue CASCADE;
DROP TABLE IF EXISTS station_shift_assignments CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS fabrics CASCADE;
DROP TABLE IF EXISTS shifts CASCADE;
DROP TABLE IF EXISTS stations CASCADE;

-- 2. Creación de Tablas

CREATE TABLE stations (
  id SERIAL PRIMARY KEY,
  codigo TEXT NOT NULL UNIQUE
);

CREATE TABLE shifts (
  id SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE,
  hora_inicio TIME NOT NULL, -- Uso de TIME para mejor validación
  hora_fin TIME NOT NULL
);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nombre TEXT NOT NULL,
  rol TEXT NOT NULL CHECK (rol IN ('SUPERVISOR','GERENTE','SISTEMAS')),
  activo INTEGER NOT NULL DEFAULT 1 -- 1: Activo, 0: Inactivo
);

CREATE TABLE station_shift_assignments (
  id SERIAL PRIMARY KEY,
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  encargado_nombre TEXT NOT NULL,
  activo INTEGER NOT NULL DEFAULT 1,
  UNIQUE (station_id, shift_id)
);

CREATE TABLE fabrics (
  id SERIAL PRIMARY KEY,
  codigo_tela TEXT NOT NULL UNIQUE,
  descripcion TEXT,
  total_fajas INTEGER NOT NULL CHECK (total_fajas > 0)
);

CREATE TABLE station_queue (
  id SERIAL PRIMARY KEY,
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  fabric_id INTEGER NOT NULL REFERENCES fabrics(id) ON DELETE CASCADE,
  orden INTEGER NOT NULL,
  activa INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE station_state (
  station_id INTEGER PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE,
  fabric_id_actual INTEGER REFERENCES fabrics(id) ON DELETE SET NULL,
  siguiente_faja INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE shift_logs (
  id SERIAL PRIMARY KEY,
  fecha DATE NOT NULL DEFAULT CURRENT_DATE,
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

-- 3. Funciones y Triggers

-- Función para actualizar automáticamente updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW();
   RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger en station_state
CREATE TRIGGER update_station_state_updated_at
BEFORE UPDATE ON station_state
FOR EACH ROW
EXECUTE PROCEDURE update_updated_at_column();
