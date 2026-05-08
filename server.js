import express from "express";
import multer from "multer";
import Anthropic from "@anthropic-ai/sdk";
import Stripe from "stripe";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("Only image files are allowed"));
    cb(null, true);
  },
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ─── In-memory store ──────────────────────────────────────────────────────────
// Maps paymentIntentId → full analysis JSON
// In production: replace with Redis or a database
const reportStore = new Map();

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// Stripe webhooks need raw body — must be before express.json()
app.use("/api/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ─── FREE endpoint: analyse photo, return only score + Stripe clientSecret ────
app.post("/api/analyse", upload.single("portrait"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image file provided." });

  const base64Image = req.file.buffer.toString("base64");
  const mimeType = req.file.mimetype;

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      system: `You are an elite facial aesthetics analyst trained on peer-reviewed studies in evolutionary biology, perceptual psychology, and clinical aesthetic medicine. Analyse with scientific precision and a luxury brand voice — authoritative, sophisticated, never judgmental. Return ONLY valid JSON, no markdown, no preamble:
{
  "overallScore": <number 0-100>,
  "symmetry": {"score": <0-100>, "observation": "<2 sentences>"},
  "proportions": {"score": <0-100>, "observation": "<2 sentences>"},
  "features": {"score": <0-100>, "observation": "<2 sentences>"},
  "skinQuality": {"score": <0-100>, "observation": "<2 sentences>"},
  "strengths": "<2-3 sentences about standout positive attributes>",
  "tips": ["<science-backed tip 1>","<tip 2>","<tip 3>","<tip 4>","<tip 5>"],
  "hairstyles": {
    "faceShape": "<oval|round|square|heart|oblong|diamond>",
    "faceShapeExplanation": "<1-2 sentences>",
    "recommended": [
      {"name": "<hairstyle>", "why": "<1 sentence>"},
      {"name": "<hairstyle>", "why": "<1 sentence>"},
      {"name": "<hairstyle>", "why": "<1 sentence>"}
    ],
    "avoid": [
      {"name": "<hairstyle>", "why": "<1 sentence>"},
      {"name": "<hairstyle>", "why": "<1 sentence>"}
    ]
  },
  "naturalImprovements": [
    {"category": "<Skincare|Nutrition|Sleep|Fitness|Grooming|Posture>", "title": "<short title>", "description": "<2 sentences>", "scoreImpact": "<low|medium|high>"},
    {"category": "...", "title": "...", "description": "...", "scoreImpact": "..."},
    {"category": "...", "title": "...", "description": "...", "scoreImpact": "..."},
    {"category": "...", "title": "...", "description": "...", "scoreImpact": "..."},
    {"category": "...", "title": "...", "description": "...", "scoreImpact": "..."}
  ]
}`,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: base64Image } },
          { type: "text", text: "Perform a complete facial aesthetic analysis. Be precise, scientific, and constructive." }
        ]
      }]
    });

    const raw = message.content.map(b => b.text || "").join("").trim();
    const fullAnalysis = JSON.parse(raw);

    // Create a Stripe PaymentIntent for €7.99
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 799,
      currency: "eur",
      automatic_payment_methods: { enabled: true },
      metadata: { product: "visage_full_report" }
    });

    // Store full analysis keyed to paymentIntentId
    reportStore.set(paymentIntent.id, fullAnalysis);

    // Return ONLY the free score + Stripe data
    res.json({
      overallScore: fullAnalysis.overallScore,
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });

  } catch (err) {
    console.error("Analysis error:", err);
    if (err instanceof SyntaxError) return res.status(500).json({ error: "Failed to parse AI response." });
    if (err.status === 400) return res.status(400).json({ error: "Image could not be processed. Please use a clear, front-facing portrait." });
    res.status(500).json({ error: "Analysis failed. Please try again." });
  }
});

// ─── PAID endpoint: verify payment, return full report ────────────────────────
app.get("/api/report/:paymentIntentId", async (req, res) => {
  const { paymentIntentId } = req.params;
  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (pi.status !== "succeeded") {
      return res.status(402).json({ error: "Payment not yet completed." });
    }

    const report = reportStore.get(paymentIntentId);
    if (!report) {
      return res.status(404).json({ error: "Report expired. Please run a new analysis." });
    }

    res.json(report);
  } catch (err) {
    console.error("Report fetch error:", err);
    res.status(500).json({ error: "Could not verify payment." });
  }
});

// ─── Stripe Webhook ───────────────────────────────────────────────────────────
app.post("/api/webhook", (req, res) => {
  const sig = req.headers["stripe-signature"];
  try {
    stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || "");
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  res.json({ received: true });
});

// ─── Catch-all ────────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VISAGE server running → http://localhost:${PORT}`));
