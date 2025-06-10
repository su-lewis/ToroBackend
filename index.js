// backend/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./lib/prisma'); // Assuming backend/lib/prisma.js exports the Prisma client

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
// Define allowed origins. For production, this should be your specific frontend URL.
// For development, you might add http://localhost:3000 if you also test locally against deployed backend.
const allowedOrigins = [
    frontendUrlFromEnv || 'http://localhost:3000' // Fallback for local if env var is missing
];
// If you have multiple specific frontend URLs (e.g., production, staging)
// const allowedOrigins = [
//   'https://your-production-frontend.vercel.app',
//   'https://your-staging-frontend.vercel.app',
//   'http://localhost:3000' // For local development
// ];


const corsOptions = {
  origin: function (origin, callback) {
    // The 'origin' parameter is the origin header from the incoming request.
    // For requests from your Vercel frontend, 'origin' will be something like 'https://frontend-black-five-11.vercel.app'
    console.log(`[CORS] Incoming request from Origin: ${origin}`);
    console.log(`[CORS] Allowed Origins configured: ${allowedOrigins.join(', ')}`);

    // Allow requests with no origin (e.g., server-to-server, curl, mobile apps in some cases)
    // OR if the origin is in the allowedOrigins list.
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      // console.log(`[CORS] Origin ${origin || 'N/A'} is ALLOWED.`);
      callback(null, true); // Origin is allowed
    } else {
      console.error(`[CORS] Origin ${origin} is NOT ALLOWED. Current allowedOrigins: ${allowedOrigins.join(', ')}`);
      callback(new Error(`Origin [${origin}] not allowed by CORS policy`)); // Origin is not allowed
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Must include OPTIONS for preflight
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Info'], // Add any other custom headers your client sends
  credentials: true, // Useful if you were to ever use cookies/sessions across origins
  optionsSuccessStatus: 204 // For preflight OPTIONS requests
};

// Apply CORS middleware globally and as early as possible.
// This handles the preflight OPTIONS requests.
app.use(cors(corsOptions));


// --- Body Parsers ---
// General JSON parser for request bodies.
// This MUST come after CORS but before route handlers that need parsed JSON.
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
// All routes defined in these router files will now benefit from the global CORS and express.json()
app.use('/api/stripe', stripeRoutes);
app.use('/api/public', publicProfileRoutes); // e.g., /api/public/profile/:username
app.use('/api/users', userRoutes);         // e.g., /api/users/me, /api/users/profile

app.use('/api/links', authMiddleware, (req, res, next) => {
  // This additional check ensures localUser (app-specific profile) exists before accessing link routes
  if (!req.localUser) {
    return res.status(403).json({ message: "User profile must be set up to manage links.", code: "PROFILE_REQUIRED_FOR_LINKS" });
  }
  next();
}, linkRoutes);

// Simple health check or root API endpoint
app.get('/api', (req, res) => {
  res.status(200).send('Link Bio API is healthy and running!');
});


// Centralized Error Handling Middleware (should be the LAST app.use() call)
app.use((err, req, res, next) => {
  console.error("--- Unhandled Express Error ---");
  console.error("Timestamp:", new Date().toISOString());
  console.error("Route:", req.method, req.originalUrl);
  // console.error("Headers:", req.headers); // Be careful logging headers if they contain sensitive info
  console.error("Error Message:", err.message);
  console.error("Error Stack:", err.stack);
  console.error("--- End Unhandled Express Error ---");

  if (res.headersSent) {
    return next(err); // If headers already sent, delegate to default Express error handler
  }
  
  // Specific check for CORS errors thrown by our origin function
  if (err.message && err.message.includes("not allowed by CORS")) {
    return res.status(403).json({ error: "CORS_POLICY_VIOLATION", message: err.message });
  }

  // For other errors, send a generic 500 or the status from the error object
  res.status(err.status || 500).json({ 
    error: "INTERNAL_SERVER_ERROR",
    message: err.message || 'An unexpected internal server error occurred on the API!',
    // Optionally, in development, you could send more error details
    // details: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });
});


app.listen(PORT, () => {
  console.log(`Backend server running. Listening on port ${PORT}`);
  console.log(`CORS configured. Allowed origins: ${allowedOrigins.join(', ')}`);
  if (!frontendUrlFromEnv) {
    console.warn("Reminder: FRONTEND_URL env var is not set; using fallback for CORS.");
  }
});