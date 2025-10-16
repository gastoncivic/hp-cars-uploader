
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
import { v4 as uuidv4 } from "uuid";
import mercadopago from "mercadopago";
import paypal from "@paypal/checkout-server-sdk";
import admin from "firebase-admin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// ====== ENV ======
const PORT = process.env.PORT || 8080;
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const PUBLIC_BASE = process.env.PUBLIC_BASE || `http://localhost:${PORT}`;

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "0", 10);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const MAIL_FROM  = process.env.MAIL_FROM || SMTP_USER || "no-reply@hp-cars.local";

// Mercado Pago
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";
if (MP_ACCESS_TOKEN) mercadopago.configure({ access_token: MP_ACCESS_TOKEN });

// PayPal
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "";
const PAYPAL_ENV = (process.env.PAYPAL_ENV || "sandbox").toLowerCase();
function paypalClient() {
  const Environment = PAYPAL_ENV === "live"
    ? paypal.core.LiveEnvironment
    : paypal.core.SandboxEnvironment;
  return new paypal.core.PayPalHttpClient(new Environment(PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET));
}

// Firebase Admin (token verification)
try {
  if (!admin.apps.length && process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    });
    console.log("Firebase Admin inicializado");
  }
} catch (e) {
  console.warn("Firebase Admin no inicializado:", e.message);
}

// ====== CORS ======
app.use(cors({
  origin: function(origin, cb) {
    if (!origin || ALLOWED_ORIGIN === "*" || origin === ALLOWED_ORIGIN) return cb(null, true);
    return cb(new Error("Not allowed by CORS: " + origin));
  },
  credentials: true
}));

// ====== Storage & DB ======
const FILES_DIR = path.join(__dirname, "files");
const RESULTS_DIR = path.join(__dirname, "results");
const DATA_DIR = path.join(__dirname, "data");
const ORDERS_DB = path.join(DATA_DIR, "orders.json");
fs.mkdirSync(FILES_DIR, { recursive: true });
fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadOrders() {
  if (!fs.existsSync(ORDERS_DB)) {
    fs.writeFileSync(ORDERS_DB, JSON.stringify({ orders: [] }, null, 2));
  }
  const raw = fs.readFileSync(ORDERS_DB, "utf-8");
  return JSON.parse(raw);
}
function saveOrders(db) {
  fs.writeFileSync(ORDERS_DB, JSON.stringify(db, null, 2));
}

// ====== Auth middleware (verifica Firebase token si está activo) ======
async function verifyAuth(req, res, next) {
  if (!admin.apps.length) return next(); // sin verificación si no config
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ ok:false, error:"Missing Bearer token" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    return next();
  } catch (e) {
    return res.status(401).json({ ok:false, error:"Invalid token" });
  }
}

// ====== Uploads ======
const allowedExts = [".bin",".hex",".kp",".ols",".ecu"];
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, FILES_DIR),
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^\w\-.]+/g, "_");
      cb(null, `${Date.now()}_${safe}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!allowedExts.includes(ext)) return cb(new Error("Tipo de archivo no permitido"));
    cb(null, true);
  }
});

const uploadResult = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, RESULTS_DIR),
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^\w\-.]+/g, "_");
      cb(null, `${Date.now()}_${safe}`);
    }
  }),
  limits: { fileSize: 32 * 1024 * 1024 }
});

// ====== Static ======
app.use("/files", express.static(FILES_DIR));
app.use("/results", express.static(RESULTS_DIR));

// ====== Health ======
app.get("/", (req, res) => res.json({ ok: true, msg: "API OK" }));

// ====== Upload original & create order ======
app.post("/uploadBin", verifyAuth, upload.single("file"), (req, res) => {
  try {
    const body = req.body || {};
    const email = (body.email || (req.user?.email || "")).toString();
    const meta = {
      marca: body.marca || "", modelo: body.modelo || "", motor: body.motor || "",
      combustible: body.combustible || "", anio: body.anio || "", transmision: body.transmision || "",
      ecu: body.ecu || ""
    };
    const soluciones = {
      egrOff: body.egrOff === "true" || body.egrOff === true,
      dpfOff: body.dpfOff === "true" || body.dpfOff === true,
      dtcOff: body.dtcOff === "true" || body.dtcOff === true,
      stage1: body.stage1 === "true" || body.stage1 === true,
      stage2: body.stage2 === "true" || body.stage2 === true,
      vmax:   body.vmax === "true"   || body.vmax === true,
      immoOff: body.immoOff === "true" || body.immoOff === true
    };
    const comments = body.comentarios || "";
    const file = req.file;
    if (!file) return res.status(400).json({ ok:false, error:"Falta archivo" });

    const fileUrl = `${PUBLIC_BASE}/files/${path.basename(file.path)}`;
    const order = {
      orderId: uuidv4(),
      userEmail: email,
      meta, soluciones, comments,
      originalFileName: path.basename(file.path),
      originalFileUrl: fileUrl,
      resultFileName: "",
      resultFileUrl: "",
      status: "uploaded",
      paymentProvider: "",
      paymentId: "",
      paymentStatus: "",
      rating: 0,
      feedback: "",
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    const db = loadOrders();
    db.orders.push(order);
    saveOrders(db);
    return res.json({ ok:true, order });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error:e.message });
  }
});

// ====== Orders ======
app.get("/orders", verifyAuth, (req, res) => {
  const email = (req.query.email || req.user?.email || "").toString();
  const db = loadOrders();
  const out = email ? db.orders.filter(o => (o.userEmail||"").toLowerCase() == email.toLowerCase()) : [];
  res.json({ ok:true, orders: out });
});

// admin list all (requires ADMIN_KEY header)
app.get("/admin/orders", (req, res) => {
  if ((req.headers["x-admin-key"] || "") !== ADMIN_KEY) {
    return res.status(401).json({ ok:false, error:"Unauthorized" });
  }
  const db = loadOrders();
  res.json({ ok:true, orders: db.orders });
});

// admin: mark ready + attach result url
app.post("/orders/:orderId/mark-ready", (req, res) => {
  if ((req.headers["x-admin-key"] || "") !== ADMIN_KEY) {
    return res.status(401).json({ ok:false, error:"Unauthorized" });
  }
  const { orderId } = req.params;
  const { resultFileUrl } = req.body || {};
  const db = loadOrders();
  const idx = db.orders.findIndex(o => o.orderId === orderId);
  if (idx < 0) return res.status(404).json({ ok:false, error:"Order not found" });
  db.orders[idx].resultFileUrl = resultFileUrl || db.orders[idx].resultFileUrl;
  db.orders[idx].status = "ready";
  db.orders[idx].updatedAt = Date.now();
  saveOrders(db);
  res.json({ ok:true, order: db.orders[idx] });
});

// user: rate
app.post("/orders/:orderId/rate", verifyAuth, (req, res) => {
  const { orderId } = req.params;
  const { rating = 0, feedback = "" } = req.body || {};
  const db = loadOrders();
  const idx = db.orders.findIndex(o => o.orderId === orderId && o.userEmail === (req.user?.email||""));
  if (idx < 0) return res.status(404).json({ ok:false, error:"Order not found" });
  db.orders[idx].rating = Math.max(0, Math.min(5, parseInt(rating,10) || 0));
  db.orders[idx].feedback = (feedback || "").toString().slice(0, 2000);
  db.orders[idx].updatedAt = Date.now();
  saveOrders(db);
  res.json({ ok:true, order: db.orders[idx] });
});

// admin: delete order
app.delete("/orders/:orderId", (req, res) => {
  if ((req.headers["x-admin-key"] || "") !== ADMIN_KEY) {
    return res.status(401).json({ ok:false, error:"Unauthorized" });
  }
  const { orderId } = req.params;
  const db = loadOrders();
  const idx = db.orders.findIndex(o => o.orderId === orderId);
  if (idx < 0) return res.status(404).json({ ok:false, error:"Order not found" });
  const [removed] = db.orders.splice(idx,1);
  saveOrders(db);
  res.json({ ok:true, removed });
});

// ====== Upload result (admin) ======
app.post("/uploadResult", uploadResult.single("file"), async (req, res) => {
  try {
    if ((req.headers["x-admin-key"] || "") !== ADMIN_KEY) {
      return res.status(401).json({ ok:false, error:"Unauthorized" });
    }
    const { email="", orderId="" } = req.body || {};
    const file = req.file;
    if (!file) return res.status(400).json({ ok:false, error:"Falta archivo" });
    const resultUrl = `${PUBLIC_BASE}/results/${path.basename(file.path)}`;

    if (orderId) {
      const db = loadOrders();
      const idx = db.orders.findIndex(o => o.orderId === orderId);
      if (idx >= 0) {
        db.orders[idx].resultFileName = path.basename(file.path);
        db.orders[idx].resultFileUrl = resultUrl;
        db.orders[idx].status = "ready";
        db.orders[idx].updatedAt = Date.now();
        saveOrders(db);
      }
    }

    if (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS && email) {
      const t = nodemailer.createTransport({
        host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
        auth: { user: SMTP_USER, pass: SMTP_PASS }
      });
      await t.sendMail({
        from: MAIL_FROM,
        to: email,
        subject: "Tu archivo modificado está listo",
        html: `<p>Hola, tu archivo modificado está listo.</p><p>Descarga: <a href="${resultUrl}">${resultUrl}</a></p>`
      });
    }

    res.json({ ok:true, url: resultUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ====== MERCADO PAGO (real) ======
app.post("/payments/mp/create-preference", async (req, res) => {
  try{
    if(!MP_ACCESS_TOKEN) return res.status(400).json({ ok:false, error:"MP_ACCESS_TOKEN no configurado" });
    const { orderId, amount } = req.body || {};
    if(!orderId || !amount) return res.status(400).json({ ok:false, error:"Faltan orderId/amount" });
    const preference = {
      items: [{ title: `Chiptuning ${orderId}`, quantity: 1, currency_id: "ARS", unit_price: Number(amount) }],
      back_urls: {
        success: `${PUBLIC_BASE}/payments/mp/return?status=success&orderId=${orderId}`,
        failure: `${PUBLIC_BASE}/payments/mp/return?status=failure&orderId=${orderId}`,
        pending: `${PUBLIC_BASE}/payments/mp/return?status=pending&orderId=${orderId}`
      },
      auto_return: "approved",
      notification_url: `${PUBLIC_BASE}/payments/mp/webhook`
    };
    const response = await mercadopago.preferences.create(preference);
    res.json({ ok:true, id: response.body.id, init_point: response.body.init_point });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Webhook Mercado Pago
app.post("/payments/mp/webhook", express.json(), async (req, res) => {
  try{
    const body = req.body || {};
    // En producción: consultar detalle de pago por id (body.data.id) y verificar estado "approved"
    const orderId = (body?.data?.orderId) || req.query?.orderId || ""; // adaptar según notificación
    if (orderId) {
      const db = loadOrders();
      const idx = db.orders.findIndex(o => o.orderId === orderId);
      if (idx >= 0) {
        db.orders[idx].paymentStatus = "approved";
        db.orders[idx].paymentProvider = "mercadopago";
        db.orders[idx].status = "paid";
        db.orders[idx].updatedAt = Date.now();
        saveOrders(db);
      }
    }
    res.sendStatus(200);
  }catch(e){
    res.sendStatus(200);
  }
});

// ====== PAYPAL (real) ======
app.post("/payments/paypal/create-order", async (req, res) => {
  try{
    const { orderId, amount, currency="USD" } = req.body || {};
    if(!orderId || !amount) return res.status(400).json({ ok:false, error:"Faltan datos" });
    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer("return=representation");
    request.requestBody({
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: orderId,
        amount: { currency_code: currency, value: String(amount) }
      }],
      application_context: {
        return_url: `${PUBLIC_BASE}/payments/paypal/return?orderId=${orderId}`,
        cancel_url: `${PUBLIC_BASE}/payments/paypal/cancel?orderId=${orderId}`
      }
    });
    const response = await paypalClient().execute(request);
    const approve = response.result.links?.find(l=>l.rel==="approve")?.href;
    res.json({ ok:true, id: response.result.id, approve });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.post("/payments/paypal/capture-order", async (req, res) => {
  try{
    const { paypalOrderId, orderId } = req.body || {};
    if(!paypalOrderId || !orderId) return res.status(400).json({ ok:false, error:"Faltan ids" });
    const request = new paypal.orders.OrdersCaptureRequest(paypalOrderId);
    request.requestBody({});
    const response = await paypalClient().execute(request);
    if (response.result.status === "COMPLETED") {
      const db = loadOrders();
      const idx = db.orders.findIndex(o => o.orderId === orderId);
      if (idx >= 0) {
        db.orders[idx].paymentStatus = "approved";
        db.orders[idx].paymentProvider = "paypal";
        db.orders[idx].status = "paid";
        db.orders[idx].updatedAt = Date.now();
        saveOrders(db);
      }
    }
    res.json({ ok:true, status: response.result.status });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.listen(PORT, () => console.log("Server running on", PORT));
