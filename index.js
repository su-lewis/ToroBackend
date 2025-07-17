// backend/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./lib/prisma');

const app = express();
const PORT = process.env.PORT || 3001;

// --- CORS Configuration ---
const frontendUrlFromEnv = process.env.FRONTEND_URL;
if (!frontendUrlFromEnv) {
    console.warn("WARNING: FRONTEND_URL env var not set. Defaulting to http://localhost:3000 for CORS.");
}
const allowedOrigins = [frontendUrlFromEnv || 'http://localhost:3000'].filter(Boolean);
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.error(`CORS Error: Origin ${origin} is NOT ALLOWED.`);
      callback(new Error(`Origin [${origin}] not allowed by CORS policy`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Info'],
  credentials: true,
  optionsSuccessStatus: 204 
};

// Apply CORS globally and FIRST.
app.use(cors(corsOptions));

// --- Import Routers and Handlers ---
// Destructure the exports from stripe.js
const { stripeRouter, stripeWebhookHandler } = require('./routes/stripe'); 
const userRoutes = require('./routes/users');
const linkRoutes = require('./routes/links');
const publicProfileRoutes = require('./routes/publicProfile');
const { authMiddleware } = require('./middleware/auth');


// --- MIDDLEWARE & ROUTER ORDERING ---

// 1. Define the Stripe Webhook route FIRST. It has its own raw body parser.
// This ensures that incoming webhook requests are not parsed as JSON by global middleware.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);


// 2. Now, apply the global JSON parser for all other requests.
app.use(express.json());


// 3. Mount all other routers that expect JSON bodies.
// The /api/stripe router here will handle all routes defined in stripeRouter
// (like /create-checkout-session), and they will correctly use the global JSON parser.
app.use('/api/stripe', stripeRouter); 
app.use('/api/public', publicProfileRoutes);
app.use('/api/users', userRoutes);

app.use('/api/links', authMiddleware, (req, res, next) => {
  if (!req.localUser) {
    return res.status(403).json({ 
        message: "User profile must be set up to manage links.", 
        code: "PROFILE_REQUIRED_FOR_LINKS" 
    });
  }
  next();
}, linkRoutes);


// Simple health check endpoint
app.get('/api', (req, res) => {
  res.status(200).json({ status: 'healthy', message: 'Link Bio API is running!' });
});


// --- Centralized Error Handling Middleware (must be last) ---
app.use((err, req, res, next) => {
  console.error("--- Unhandled Express Error ---");
  console.error("Timestamp:", new Date().toISOString());
  console.error("Route:", req.method, req.originalUrl);
  console.error("Error Message:", err.message);
  console.error("Error Stack:", err.stack);
  console.error("--- End Unhandled Express Error ---");

  if (res.headersSent) { return next(err); }
  
  if (err.message && err.message.includes("not allowed by CORS")) {
    return res.status(403).json({ error: "CORS_POLICY_VIOLATION", message: err.message });
  }

  res.status(err.status || 500).json({ 
    error: "INTERNAL_SERVER_ERROR",
    message: err.message || 'An unexpected internal server error occurred on the API!',
  });
});


// --- Start Server ---
app.listen(PORT, () => {
  console.log(`Backend server running. Listening on port ${PORT}`);
  console.log(`CORS configured. Allowed origins: [${allowedOrigins.join(', ')}]`);
  if (!frontendUrlFromEnv) {
    console.warn("Reminder: FRONTEND_URL env var is not set; using fallback for CORS. This should be set in production.");
  }
});