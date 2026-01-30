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
app.use(express.static(path.join(__dirname, "../public")));

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
    res.status(500).json({ error: "Error en el servidor" });
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
