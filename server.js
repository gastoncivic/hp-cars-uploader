// servidor.js (ESM)
import express from "express";
import cors from "cors";
import fileUpload from "express-fileupload";
import morgan from "morgan";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// ************ C O R S ************
const ALLOWED_ORIGINS = [
  "https://hp-cars.web.app",
  "http://localhost:8080",
  "http://localhost:5000",
  "http://localhost:3000",
  "http://127.0.0.1:5000",
  "http://127.0.0.1:3000"
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // permitir curl / file://
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, true); // relajado para pruebas; endurecer en prod si querés
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);

app.use(morgan("dev"));
app.use(express.json());

// ************ U P L O A D S ************
app.use(
  fileUpload({
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
    abortOnLimit: true,
    useTempFiles: true,
    tempFileDir: path.join(__dirname, "tmp")
  })
);

// Static público para descargas
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOAD_DIR));

// “DB” simple en JSON
const DB_FILE = path.join(__dirname, "orders.json");
function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return [];
  }
}
function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}
const safeName = (n) => n.replace(/[^a-zA-Z0-9._-]/g, "_");

// ************ R U T A S ************

// Health check para Render
app.get("/api/ok", (req, res) => res.json({ ok: true, msg: "API correcta" }));

// Crear pedido + subir ORI
app.post("/api/upload", async (req, res) => {
  try {
    if (!req.files || !req.files.file) {
      return res.status(400).json({ ok: false, error: "Falta archivo 'file'." });
    }
    const f = req.files.file;
    const orderId =
      "ord_" +
      new Date().toISOString().replace(/[-:.TZ]/g, "") +
      "_" +
      uuidv4().slice(0, 8);

    // Meta opcional proveniente de tu formulario
    const meta = {
      brand: req.body.brand || null,
      model: req.body.model || null,
      year: req.body.year || null,
      engine: req.body.engine || null,
      phone: req.body.phone || null,
      country: req.body.country || null,
      modsSelected: req.body.modsSelected ? JSON.parse(req.body.modsSelected) : [],
      notes: req.body.notes || null,
      totals: req.body.totals ? JSON.parse(req.body.totals) : null
    };

    const folder = path.join(UPLOAD_DIR, orderId);
    fs.mkdirSync(folder, { recursive: true });
    const dest = path.join(folder, safeName(f.name || "original.bin"));
    await f.mv(dest);

    const db = readDB();
    const record = {
      orderId,
      originalName: f.name,
      originalPath: `/uploads/${orderId}/${path.basename(dest)}`,
      size: f.size,
      mimetype: f.mimetype,
      status: "pending",
      createdAt: new Date().toISOString(),
      meta,
      modified: null
    };
    db.push(record);
    writeDB(db);

    res.json({ ok: true, orderId, downloadURL: record.originalPath });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Error de servidor" });
  }
});

// Listar pedidos
app.get("/api/orders", (req, res) => {
  const orders = readDB().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ ok: true, orders });
});

// Cambiar estado
app.post("/api/orders/:orderId/status", (req, res) => {
  const { orderId } = req.params;
  const { status } = req.body || {};
  const allowed = ["pending", "in_progress", "ready", "delivered", "rejected"];
  if (!allowed.includes(status))
    return res.status(400).json({ ok: false, error: "Estado inválido" });

  const db = readDB();
  const i = db.findIndex((x) => x.orderId === orderId);
  if (i < 0) return res.status(404).json({ ok: false, error: "No encontrado" });
  db[i].status = status;
  db[i].updatedAt = new Date().toISOString();
  writeDB(db);
  res.json({ ok: true, order: db[i] });
});

// Subir MOD (ingeniero)
app.post("/api/orders/:orderId/upload-mod", async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!req.files || !req.files.file) {
      return res.status(400).json({ ok: false, error: "Falta archivo 'file'." });
    }
    const db = readDB();
    const i = db.findIndex((x) => x.orderId === orderId);
    if (i < 0) return res.status(404).json({ ok: false, error: "No encontrado" });

    const f = req.files.file;
    const folder = path.join(UPLOAD_DIR, orderId);
    fs.mkdirSync(folder, { recursive: true });
    const dest = path.join(folder, safeName(f.name || "modificado.bin"));
    await f.mv(dest);

    db[i].modified = {
      name: f.name,
      path: `/uploads/${orderId}/${path.basename(dest)}`,
      size: f.size,
      uploadedAt: new Date().toISOString()
    };
    db[i].status = "ready";
    db[i].updatedAt = new Date().toISOString();
    writeDB(db);

    res.json({ ok: true, order: db[i] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Error de servidor" });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor listo en http://localhost:${PORT}`);
});
