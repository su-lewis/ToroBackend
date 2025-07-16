// backend/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./lib/prisma'); // Import Prisma client from the dedicated file

const app = express();
const PORT = process.env.PORT || 3001; // Render will set process.env.PORT

// --- CORS Configuration ---
const frontendUrlFromEnv = process.env.FRONTEND_URL;

if (!frontendUrlFromEnv) {
    console.warn(
        "--------------------------------------------------------------------------\n" +
        "WARNING: FRONTEND_URL environment variable is NOT SET in backend/.env. \n" +
        "CORS will default to allow 'http://localhost:3000' only.\n" +
        "This WILL cause CORS errors if your frontend is deployed elsewhere.\n" +
        "Set FRONTEND_URL to your deployed frontend's origin (e.g., https://your-frontend.vercel.app)\n" +
        "--------------------------------------------------------------------------"
    );
}
const allowedOrigins = [
    frontendUrlFromEnv || 'http://localhost:3000' // Fallback for local dev if env var is missing
    // To allow multiple origins (e.g., your Vercel URL and localhost):
    // process.env.FRONTEND_URL,
    // 'http://localhost:3000',
].filter(Boolean); // Filter out any undefined/null values

const corsOptions = {
  origin: function (origin, callback) {
    // For debugging CORS issues:
    // console.log(`[CORS] Incoming request from Origin: ${origin}`);
    // console.log(`[CORS] Allowed Origins configured: ${allowedOrigins.join(', ')}`);

    // Allow requests with no origin (e.g., server-to-server, curl) OR if origin is in the allowed list.
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true); // Origin is allowed
    } else {
      console.error(`[CORS] Origin ${origin} is NOT ALLOWED.`);
      callback(new Error(`Origin [${origin}] not allowed by CORS policy`)); // Origin is not allowed
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // OPTIONS is crucial for preflight requests
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Info'], // Allow necessary headers
  credentials: true, // If you ever use cookies/sessions across origins
  optionsSuccessStatus: 204 
};

// Apply CORS middleware globally and as the first middleware.
app.use(cors(corsOptions));


// --- Body Parsers ---
// The Stripe webhook route ('/api/stripe/webhook') uses its own express.raw() body parser internally.
// This global express.json() parser will apply to all other routes that need JSON bodies.
// It should come AFTER CORS but BEFORE your route handlers.
app.use(express.json());


// --- Import Routers ---
const stripeRoutes = require('./routes/stripe');
const userRoutes = require('./routes/users');
const linkRoutes = require('./routes/links');
const publicProfileRoutes = require('./routes/publicProfile');
const { authMiddleware } = require('./middleware/auth');


// --- Mount Routers ---
app.use('/api/stripe', stripeRoutes);
app.use('/api/public', publicProfileRoutes);
app.use('/api/users', userRoutes);

app.use('/api/links', authMiddleware, (req, res, next) => {
  // This additional check ensures a user has a complete app profile before managing links.
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
  console.error("Error Stack:", err.stack); // Full stack trace for debugging
  console.error("--- End Unhandled Express Error ---");

  if (res.headersSent) {
    return next(err); // Delegate to default Express handler if response already started
  }
  
  // Specific check for CORS errors thrown by our origin function
  if (err.message && err.message.includes("not allowed by CORS")) {
    return res.status(403).json({ error: "CORS_POLICY_VIOLATION", message: err.message });
  }

  // Generic fallback error response
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