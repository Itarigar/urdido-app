require("dotenv").config();
const pool = require("./db");

(async () => {
    try {
        console.log("Checking 'users' table columns...");
        
        // Check if column exists
        const checkRes = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name='users' AND column_name='created_at';
        `);

        if (checkRes.rows.length === 0) {
            console.log("Column 'created_at' MISSING. Adding it...");
            await pool.query(`
                ALTER TABLE users ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
            `);
            console.log("Column 'created_at' ADDED.");
        } else {
            console.log("Column 'created_at' ALREADY EXISTS.");
        }

        // Verify again
        const verifyRes = await pool.query("SELECT * FROM users LIMIT 1");
        console.log("User row sample keys:", Object.keys(verifyRes.rows[0]));

        process.exit(0);
    } catch (err) {
        console.error("Fix error:", err);
        process.exit(1);
    }
})();
