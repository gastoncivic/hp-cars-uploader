import express from "express";
import multer from "multer";
import cors from "cors";
import path from "path";
import fs from "fs";
import nodemailer from "nodemailer";

const app = express();
const PORT = process.env.PORT || 8080;
const UPLOAD_DIR = process.env.UPLOAD_DIR || "uploads";
const RESULTS_DIR = process.env.RESULTS_DIR || "results";
const ALLOWED = (process.env.ALLOWED_ORIGIN || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // si lo defines, se exige en /uploadResult

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(RESULTS_DIR, { recursive: true });

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (!ALLOWED.length || ALLOWED.includes(origin)) return cb(null, true);
    return cb(new Error("CORS not allowed: " + origin));
  }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function makeStorage(destDir){
  return multer.diskStorage({
    destination(_req, _file, cb) { cb(null, destDir); },
    filename(_req, file, cb) {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, Date.now() + "_" + safe);
    }
  });
}

const uploadOrig = multer({
  storage: makeStorage(UPLOAD_DIR),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const ok = [".bin", ".hex", ".kp", ".ols", ".ecu"].includes(ext);
    if (!ok) return cb(new Error("Tipo de archivo no permitido"));
    cb(null, true);
  }
}).single("file");

const uploadResult = multer({
  storage: makeStorage(RESULTS_DIR),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const ok = [".bin", ".hex", ".kp", ".ols", ".ecu", ".zip"].includes(ext);
    if (!ok) return cb(new Error("Tipo de archivo no permitido"));
    cb(null, true);
  }
}).single("result");

// === subir original ===
app.post("/uploadBin", (req, res) => {
  uploadOrig(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });
    const f = req.file;
    res.json({ ok: true, fileName: f.filename, size: f.size, url: `/files/${encodeURIComponent(f.filename)}` });
  });
});

// === listar originales ===
app.get("/api/files", async (_req, res) => {
  try {
    const files = await fs.promises.readdir(UPLOAD_DIR);
    const list = await Promise.all(files.map(async (name) => {
      const full = path.join(UPLOAD_DIR, name);
      const st = await fs.promises.stat(full);
      return { name, size: st.size, mtime: st.mtimeMs, url: `/files/${encodeURIComponent(name)}` };
    }));
    list.sort((a,b) => b.mtime - a.mtime);
    res.json({ ok: true, files: list });
  } catch (e) {
    res.json({ ok: true, files: [] });
  }
});

// === listar resultados (opcional: por prefijo) ===
app.get("/api/results", async (req, res) => {
  const forName = (req.query.for || "").toString();
  try {
    const files = await fs.promises.readdir(RESULTS_DIR);
    const list = await Promise.all(files.map(async (name) => {
      const full = path.join(RESULTS_DIR, name);
      const st = await fs.promises.stat(full);
      return { name, size: st.size, mtime: st.mtimeMs, url: `/results/${encodeURIComponent(name)}` };
    }));
    list.sort((a,b) => b.mtime - a.mtime);
    const filtered = forName ? list.filter(f => f.name.includes(forName)) : list;
    res.json({ ok: true, files: filtered });
  } catch (e) {
    res.json({ ok: true, files: [] });
  }
});

// === subir resultado (protección opcional con ADMIN_KEY) ===
app.post("/uploadResult", (req, res) => {
  if (ADMIN_KEY) {
    const k = req.headers["x-admin-key"];
    if (!k || k !== ADMIN_KEY) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }
  uploadResult(req, res, async (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });
    const file = req.file;
    const customerEmail = (req.body.email || "").toString();
    const message = (req.body.message || "").toString();
    const url = `/results/${encodeURIComponent(file.filename)}`;

    // Enviar correo si hay SMTP
    let mailed = false, mailError = null;
    try {
      const host = process.env.SMTP_HOST;
      const user = process.env.SMTP_USER;
      const pass = process.env.SMTP_PASS;
      const port = parseInt(process.env.SMTP_PORT || "587", 10);
      const from = process.env.MAIL_FROM || user;

      if (host && user && pass && customerEmail) {
        const transporter = nodemailer.createTransport({
          host, port, secure: port === 465,
          auth: { user, pass }
        });
        const publicBase = process.env.PUBLIC_BASE || ""; // ej: https://hp-cars-uploader.onrender.com
        const fullLink = publicBase ? (publicBase.replace(/\/+$/,'') + url) : url;
        const html = `<p>Tu archivo modificado está listo.</p>
                      <p><a href="${fullLink}">Descargar aquí</a></p>
                      ${message ? `<p>${message}</p>` : ""}`;
        await transporter.sendMail({
          from, to: customerEmail, subject: "HP Cars - Archivo modificado listo", html
        });
        mailed = true;
      }
    } catch (e) {
      mailError = e.message || String(e);
    }

    res.json({ ok: true, result: { fileName: file.filename, size: file.size, url }, mailed, mailError });
  });
});

// === estáticos para descarga ===
app.use("/files", express.static(UPLOAD_DIR, { maxAge: "1h" }));
app.use("/results", express.static(RESULTS_DIR, { maxAge: "1h" }));

app.get("/", (_req, res) => res.type("text").send("HP Cars uploader OK"));

app.listen(PORT, () => console.log("Uploader running on", PORT));
