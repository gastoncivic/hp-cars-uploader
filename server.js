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
const ADMIN_KEY = process.env.ADMIN_KEY || "";

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

function makeStorage(dest){
  return multer.diskStorage({
    destination(_req, _file, cb){ cb(null, dest); },
    filename(_req, file, cb){
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, Date.now()+"_"+safe);
    }
  });
}

function allowed(exts){ return (name)=> exts.includes(path.extname(name).toLowerCase()); }

const uploadOrig = multer({
  storage: makeStorage(UPLOAD_DIR),
  limits: { fileSize: 8*1024*1024 },
  fileFilter(_req, file, cb){
    const ok = allowed([".bin",".hex",".kp",".ols",".ecu"])(file.originalname);
    if(!ok) return cb(new Error("Tipo de archivo no permitido"));
    cb(null,true);
  }
}).single("file");

const uploadResult = multer({
  storage: makeStorage(RESULTS_DIR),
  limits: { fileSize: 16*1024*1024 },
  fileFilter(_req, file, cb){
    const ok = allowed([".bin",".hex",".kp",".ols",".ecu",".zip"])(file.originalname);
    if(!ok) return cb(new Error("Tipo de archivo no permitido"));
    cb(null,true);
  }
}).single("result");

// Helper: write/read metadata JSON alongside filename
async function writeMetaJSON(dir, fileName, data){
  const p = path.join(dir, fileName + ".json");
  await fs.promises.writeFile(p, JSON.stringify(data, null, 2));
}
async function readMetaJSON(dir, fileName){
  try{
    const p = path.join(dir, fileName + ".json");
    const raw = await fs.promises.readFile(p, "utf-8");
    return JSON.parse(raw);
  }catch(_){ return null; }
}

// === Subir ORIGINAL + guardar metadata del formulario ===
app.post("/uploadBin", (req, res)=>{
  uploadOrig(req, res, async (err)=>{
    if(err) return res.status(400).json({ ok:false, error: err.message });
    const f = req.file;
    const url = `/files/${encodeURIComponent(f.filename)}`;
    // Capturamos metadata enviada desde el form
    const meta = {
      when: Date.now(),
      email: (req.body.email || "").toString(),
      whatsapp: (req.body.whatsapp || req.body.whatsApp || "").toString(),
      marca: req.body.marca || req.body.brand || "",
      modelo: req.body.modelo || req.body.model || "",
      motor: req.body.motor || "",
      combustible: req.body.combustible || "",
      anio: req.body.anio || req.body.year || "",
      transmision: req.body.transmision || req.body.transmision || "",
      ecu: req.body.ecu || "",
      soluciones: {
        egrOff: !!req.body.egr_off || req.body.egr_off==="on",
        dpfOff: !!req.body.dpf_off || req.body.dpf_off==="on",
        dtcOff: !!req.body.dtc_off || req.body.dtc_off==="on",
        stage1: !!req.body.stage1 || req.body.stage1==="on",
        stage2: !!req.body.stage2 || req.body.stage2==="on",
        vmax:   !!req.body.vmax   || req.body.vmax==="on",
        immoOff:!!req.body.immo_off|| req.body.immo_off==="on"
      },
      comentarios: req.body.comentarios || req.body.comentario || req.body.notes || ""
    };
    try{ await writeMetaJSON(UPLOAD_DIR, f.filename, meta); }catch(_){}
    res.json({ ok:true, fileName: f.filename, size: f.size, url, metaSaved:true });
  });
});

// === Listar ORIGINALES (enriquecidos con meta si existe) ===
app.get("/api/files", async (_req, res)=>{
  try{
    const names = await fs.promises.readdir(UPLOAD_DIR);
    const list = await Promise.all(names.filter(n => !n.endsWith(".json")).map(async name => {
      const full = path.join(UPLOAD_DIR, name);
      const st = await fs.promises.stat(full);
      const meta = await readMetaJSON(UPLOAD_DIR, name);
      return { name, size: st.size, mtime: st.mtimeMs, url: `/files/${encodeURIComponent(name)}`, meta };
    }));
    list.sort((a,b)=> b.mtime - a.mtime);
    res.json({ ok:true, files: list });
  }catch(e){
    res.json({ ok:true, files: [] });
  }
});

// === Listar RESULTADOS opcional ===
app.get("/api/results", async (req,res)=>{
  const forName = (req.query.for||"").toString();
  try{
    const names = await fs.promises.readdir(RESULTS_DIR);
    const list = await Promise.all(names.filter(n => !n.endsWith(".json")).map(async name=>{
      const full = path.join(RESULTS_DIR, name);
      const st = await fs.promises.stat(full);
      const meta = await readMetaJSON(RESULTS_DIR, name);
      return { name, size: st.size, mtime: st.mtimeMs, url: `/results/${encodeURIComponent(name)}`, meta };
    }));
    list.sort((a,b)=> b.mtime - a.mtime);
    const filtered = forName ? list.filter(f => f.name.includes(forName)) : list;
    res.json({ ok:true, files: filtered });
  }catch(e){
    res.json({ ok:true, files: [] });
  }
});

// === Subir RESULTADO + mail al cliente ===
app.post("/uploadResult", (req,res)=>{
  if(ADMIN_KEY){
    const k = req.headers["x-admin-key"];
    if(!k || k !== ADMIN_KEY) return res.status(401).json({ ok:false, error:"UNAUTHORIZED" });
  }
  uploadResult(req,res, async (err)=>{
    if(err) return res.status(400).json({ ok:false, error: err.message });
    const file = req.file;
    const forOriginal = (req.body.for || "").toString();
    const customerEmail = (req.body.email || "").toString();
    const message = (req.body.message || "").toString();
    const url = `/results/${encodeURIComponent(file.filename)}`;

    // Guardamos meta del resultado (vinculo y mensaje)
    const meta = { when: Date.now(), forOriginal, email: customerEmail, message };
    try{ await writeMetaJSON(RESULTS_DIR, file.filename, meta); }catch(_){}

    // Enviar correo si hay SMTP
    let mailed=false, mailError=null;
    try{
      const host = process.env.SMTP_HOST;
      const user = process.env.SMTP_USER;
      const pass = process.env.SMTP_PASS;
      const port = parseInt(process.env.SMTP_PORT || "587",10);
      const from = process.env.MAIL_FROM || user;
      if(host && user && pass && customerEmail){
        const transporter = nodemailer.createTransport({ host, port, secure: (port===465), auth: { user, pass } });
        const publicBase = process.env.PUBLIC_BASE || "";
        const fullLink = publicBase ? (publicBase.replace(/\/+$/,'') + url) : url;
        const html = `<p>Tu archivo modificado está listo.</p>
                      <p><a href="${fullLink}">Descargar aquí</a></p>
                      ${message ? `<p>${message}</p>` : ""}`;
        await transporter.sendMail({ from, to: customerEmail, subject:"HP Cars - Archivo modificado listo", html });
        mailed=true;
      }
    }catch(e){ mailError = e.message || String(e); }

    res.json({ ok:true, result:{ fileName:file.filename, url }, mailed, mailError });
  });
});

// Estáticos
app.use("/files", express.static(UPLOAD_DIR, { maxAge: "1h" }));
app.use("/results", express.static(RESULTS_DIR, { maxAge: "1h" }));

app.get("/", (_req,res)=> res.type("text").send("HP Cars uploader OK"));

app.listen(PORT, ()=> console.log("Uploader running on", PORT));
