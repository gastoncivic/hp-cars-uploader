
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

// CONFIG
const ALLOWED_ORIGINS = [
  "http://localhost:5000",
  "http://127.0.0.1:5000",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:8080",
  "https://hp-cars.web.app"
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // allow curl/postman
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(null, true); // relax for demo
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(morgan("dev"));
app.use(express.json());

// Subidas locales
app.use(fileUpload({
  limits: { fileSize: 20 * 1024 * 1024 },
  abortOnLimit: true,
  useTempFiles: true,
  tempFileDir: path.join(__dirname, "tmp")
}));

// Estático
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOAD_DIR));

const DB_FILE = path.join(__dirname, "orders.json");
function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return []; }
}
function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Helpers
function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// Ping
app.get("/api/ok", (req, res) => res.json({ ok: true, msg: "API correcta (local)" }));

// Crear pedido / subir archivo original
app.post("/api/upload", async (req, res) => {
  try {
    if (!req.files || !req.files.file) {
      return res.status(400).json({ ok: false, error: "No se recibió archivo 'file'." });
    }
    const file = req.files.file;
    const orderId = `ord_${new Date().toISOString().replace(/[-:.TZ]/g, "")}_${uuidv4().slice(0,8)}`;

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

    const safe = safeName(file.name);
    const folder = path.join(UPLOAD_DIR, orderId);
    fs.mkdirSync(folder, { recursive: true });

    const dest = path.join(folder, safe);
    await file.mv(dest);

    const db = readDB();
    const record = {
      orderId,
      originalName: file.name,
      originalPath: `/uploads/${orderId}/${safe}`,
      size: file.size,
      mimetype: file.mimetype,
      status: "pending",
      createdAt: new Date().toISOString(),
      meta,
      modified: null // se completa cuando el ingeniero sube el archivo modificado
    };
    db.push(record);
    writeDB(db);

    return res.json({ ok: true, orderId, downloadURL: record.originalPath });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Error de servidor" });
  }
});

// Listado de pedidos
app.get("/api/orders", (req, res) => {
  res.json({ ok: true, orders: readDB().sort((a,b)=> (a.createdAt < b.createdAt ? 1 : -1)) });
});

// Cambiar estado
app.post("/api/orders/:orderId/status", (req, res) => {
  const { orderId } = req.params;
  const { status } = req.body || {};
  const allowed = ["pending","in_progress","ready","delivered","rejected"];
  if (!allowed.includes(status)) return res.status(400).json({ ok:false, error:"Estado inválido"});
  const db = readDB();
  const idx = db.findIndex(x=>x.orderId===orderId);
  if (idx < 0) return res.status(404).json({ ok:false, error:"Pedido no encontrado"});
  db[idx].status = status;
  db[idx].updatedAt = new Date().toISOString();
  writeDB(db);
  res.json({ ok:true, order: db[idx] });
});

// Subir archivo MODIFICADO por el ingeniero
app.post("/api/orders/:orderId/upload-mod", async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!req.files || !req.files.file) {
      return res.status(400).json({ ok: false, error: "No se recibió archivo 'file'." });
    }
    const db = readDB();
    const idx = db.findIndex(x=>x.orderId===orderId);
    if (idx < 0) return res.status(404).json({ ok:false, error:"Pedido no encontrado"});
    const file = req.files.file;
    const safe = safeName(file.name || "modificado.bin");
    const folder = path.join(UPLOAD_DIR, orderId);
    fs.mkdirSync(folder, { recursive: true });
    const dest = path.join(folder, safe);
    await file.mv(dest);
    db[idx].modified = {
      name: file.name,
      path: `/uploads/${orderId}/${safe}`,
      size: file.size,
      uploadedAt: new Date().toISOString()
    };
    db[idx].status = "ready";
    db[idx].updatedAt = new Date().toISOString();
    writeDB(db);
    res.json({ ok:true, order: db[idx] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:"Error de servidor"});
  }
});

app.listen(PORT, () => {
  console.log(`Uploader local escuchando en http://localhost:${PORT}`);
});
