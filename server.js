import express from "express";
import multer from "multer";
import cors from "cors";
import path from "path";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 8080;
const UPLOAD_DIR = process.env.UPLOAD_DIR || "uploads";
const ALLOWED = (process.env.ALLOWED_ORIGIN || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

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
    const meta = {
      email: req.body?.email || "",
      waPrefix: req.body?.waPrefix || "",
      waNumber: req.body?.waNumber || "",
      marca: req.body?.marca || "",
      modelo: req.body?.modelo || "",
      anio: req.body?.anio || "",
      motor: req.body?.motor || "",
      combustible: req.body?.combustible || "",
      transmision: req.body?.transmision || "",
      ecu: req.body?.ecu || "",
      mods: req.body?.mods || "",
      comentarios: req.body?.comentarios || ""
    };
    res.json({ ok: true, fileName: f.filename, size: f.size, meta });
  });
});

app.get("/files/:name", (req, res) => {
  const p = path.join(UPLOAD_DIR, req.params.name);
  if (!fs.existsSync(p)) return res.status(404).send("Not found");
  res.download(p);
});

app.get("/", (_req, res) => res.type("text").send("HP Cars uploader OK"));

app.listen(PORT, () => console.log("Uploader running on", PORT));
