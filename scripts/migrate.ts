import { readFile } from "node:fs/promises";
import { openDatabase } from "../services/database.ts";

const pool = openDatabase();
try {
  const sql = await readFile(new URL("../migrations/001_init.sql", import.meta.url), "utf8");
  await pool.query(sql);
  console.log("MuxVault database schema is ready");
} finally {
  await pool.end();
}
