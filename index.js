// backend/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./lib/prisma');

const app = express();
const PORT = process.env.PORT || 3001;

// --- CORS Configuration ---
const frontendUrl = process.env.FRONTEND_URL;
if (!frontendUrl) {
    console.warn("WARNING: FRONTEND_URL env var not set. Defaulting to http://localhost:3000 for CORS.");
}
const allowedOrigins = [frontendUrl || 'http://localhost:3000'];
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.error(`CORS Error: Origin ${origin} not allowed by CORS policy.`);
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true, // If ever needed for cookie-based auth across origins
  optionsSuccessStatus: 204 
};
app.use(cors(corsOptions)); // Apply CORS globally FIRST

// --- Body Parsers ---
// IMPORTANT: General JSON parser for request bodies.
// This MUST come before routers/routes that need to access req.body for JSON.
app.use(express.json());

// Note: The Stripe webhook route ('/api/stripe/webhook') defined in './routes/stripe.js'
// uses its own 'express.raw({ type: "application/json" })' middleware.
// That route-specific middleware will take precedence over this global express.json()
// for that specific /webhook path, which is correct.

// Import Routers
const stripeRoutes = require('./routes/stripe');
const userRoutes = require('./routes/users');
const linkRoutes = require('./routes/links');
const publicProfileRoutes = require('./routes/publicProfile');
const { authMiddleware } = require('./middleware/auth');

// Mount Routers
app.use('/api/stripe', stripeRoutes); // All routes here will now have access to parsed req.body (except webhook)
app.use('/api/public', publicProfileRoutes);
app.use('/api/users', userRoutes);

app.use('/api/links', authMiddleware, (req, res, next) => {
  if (!req.localUser) {
    return res.status(403).json({ message: "User profile must be set up to manage links.", code: "PROFILE_REQUIRED" });
  }
  next();
}, linkRoutes);

// Simple health check or root API endpoint
app.get('/api', (req, res) => res.send('Link Bio API is healthy and Running!'));


// Centralized Error Handling Middleware (should be last)
app.use((err, req, res, next) => {
  console.error("Unhandled Express Error:", err.stack || err.message || err);
  if (res.headersSent) {
    return next(err);
  }
  if (err.message && err.message.includes("not allowed by CORS")) {
    return res.status(403).json({ message: "CORS Error: " + err.message });
  }
  res.status(err.status || 500).json({ 
    message: err.message || 'Internal Server Error!',
    // error: process.env.NODE_ENV === 'development' ? err : {} 
  });
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
  console.log(`CORS configured for origin: ${allowedOrigins.join(', ')}`);
});