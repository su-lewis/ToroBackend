require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./lib/prisma'); // Assuming backend/lib/prisma.js exports the Prisma client

const app = express();
const PORT = process.env.PORT || 3001; // Render.com provides process.env.PORT

// --- CORS Configuration ---
const frontendUrlFromEnv = process.env.FRONTEND_URL;

if (!frontendUrlFromEnv) {
    console.warn(
        "--------------------------------------------------------------------------\n" +
        "WARNING: FRONTEND_URL environment variable is NOT SET in backend/.env. \n" +
        "CORS will default to allow 'http://localhost:3000' only.\n" +
        "This WILL cause CORS errors if your frontend is deployed elsewhere.\n" +
        "--------------------------------------------------------------------------"
    );
}
const allowedOrigins = [
    frontendUrlFromEnv || 'http://localhost:3000'
].filter(Boolean);

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.error(`[CORS] Origin ${origin} is NOT ALLOWED.`);
            callback(new Error(`Origin [${origin}] not allowed by CORS policy`));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Info'],
    credentials: true,
    optionsSuccessStatus: 204
};

// Apply CORS middleware globally and FIRST.
app.use(cors(corsOptions));


// --- Import Routers ---
const stripeRoutes = require('./routes/stripe'); // This will now expose 'router' and 'handleWebhook'
const userRoutes = require('./routes/users');
const linkRoutes = require('./routes/links');
const publicProfileRoutes = require('./routes/publicProfile');
const { authMiddleware } = require('./middleware/auth');


// --- MIDDLEWARE & ROUTER ORDERING ---

// 1. Stripe Webhook-specific body parser (must be BEFORE express.json())
// This route needs to exactly match your webhook URL in Stripe dashboard.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
    // Call the exported webhook handler from stripeRoutes
    stripeRoutes.handleWebhook(req, res, next);
});

// 2. Global JSON and URL-encoded body parsers for all other routes
// These will apply to /api/stripe/create-checkout-session and all other API routes
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Good to include if you might use form data

// 3. Mount remaining routers (including other Stripe routes from the main router export)
// All routes processed AFTER `express.json()` will have `req.body` parsed.
app.use('/api/stripe', stripeRoutes.router); // Note: Accessing the 'router' property now
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

    if (res.headersSent) {
        return next(err);
    }

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