const { Pool } = require("pg");

const isProduction = process.env.NODE_ENV === "production" || (process.env.DATABASE_URL && process.env.DATABASE_URL.includes("render"));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false
});

module.exports = pool;
