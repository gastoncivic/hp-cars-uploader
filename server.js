import express from "express";
import multer from "multer";
import cors from "cors";
import path from "path";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 8080;
const UPLOAD_DIR = process.env.UPLOAD_DIR || "uploads";
const ALLOWED = (process.env.ALLOWED_ORIGIN || "")
  .split(",").map(s => s.trim()).filter(Boolean);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (!ALLOWED.length || ALLOWED.includes(origin)) return cb(null, true);
    return cb(new Error("CORS not allowed: " + origin));
  }
}));

const storage = multer.diskStorage({
  destination(req, file, cb) { cb(null, UPLOAD_DIR); },
  filename(req, file, cb) {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, Date.now() + "_" + safe);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const ok = [".bin", ".hex", ".kp", ".ols", ".ecu"].includes(ext);
    if (!ok) return cb(new Error("Tipo de archivo no permitido"));
    cb(null, true);
  }
}).single("file");

app.post("/uploadBin", (req, res) => {
  upload(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });
    const f = req.file;
    res.json({ ok: true, fileName: f.filename, size: f.size, url: `/files/${encodeURIComponent(f.filename)}` });
  });
});

// === NUEVO: listar archivos con metadatos ===
app.get("/api/files", async (req, res) => {
  try {
    const files = await fs.promises.readdir(UPLOAD_DIR);
    const list = await Promise.all(files.map(async (name) => {
      const full = path.join(UPLOAD_DIR, name);
      const st = await fs.promises.stat(full);
      return {
        name,
        size: st.size,
        mtime: st.mtimeMs,
        url: `/files/${encodeURIComponent(name)}`
      };
    }));
    list.sort((a,b) => b.mtime - a.mtime);
    res.json({ ok: true, files: list });
  } catch (e) {
    res.json({ ok: true, files: [] });
  }
});

// === NUEVO: servir los archivos para descarga
app.use("/files", express.static(UPLOAD_DIR, {
  maxAge: "1h",
}));

app.get("/", (_req, res) => res.type("text").send("HP Cars uploader OK"));

app.listen(PORT, () => console.log("Uploader running on", PORT));
