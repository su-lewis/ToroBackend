require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./lib/prisma');

const app = express();
const PORT = process.env.PORT || 3001;

// --- CORS Configuration ---
const frontendUrlFromEnv = process.env.FRONTEND_URL;
if (!frontendUrlFromEnv) { console.warn("WARNING: FRONTEND_URL environment variable is NOT SET."); }
const allowedOrigins = [frontendUrlFromEnv || 'http://localhost:3000'].filter(Boolean);
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
    optionsSuccessStatus: 204
};
app.use(cors(corsOptions));


// --- ROUTE IMPORTS ---
// Import both the router and the webhook handler from the stripe routes file
const stripeRoutes = require('./routes/stripe'); 
const userRoutes = require('./routes/users');
const linkRoutes = require('./routes/links');
const publicProfileRoutes = require('./routes/publicProfile');
const paymentRoutes = require('./routes/payments');
const { authMiddleware } = require('./middleware/auth');


// --- STRIPE WEBHOOK HANDLER ---
// The webhook is a special case that needs to be defined BEFORE app.use(express.json())
// We call the handleWebhook function that we exported from routes/stripe.js
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeRoutes.handleWebhook);


// --- GENERAL MIDDLEWARE AND ROUTE MOUNTING ---
app.use(express.json());

// Use the exported router from the stripe routes file for all other Stripe API calls
app.use('/api/stripe', stripeRoutes.router); 
app.use('/api/public', publicProfileRoutes);
app.use('/api/users', userRoutes);
app.use('/api/payments', authMiddleware, paymentRoutes);
app.use('/api/links', authMiddleware, (req, res, next) => {
    if (!req.localUser) {
        return res.status(403).json({ message: "Profile setup required." });
    }
    next();
}, linkRoutes);

app.get('/api', (req, res) => res.status(200).json({ status: 'healthy' }));


// --- ERROR HANDLING & SERVER START ---
app.use((err, req, res, next) => {
    console.error("--- Unhandled Express Error ---", err.stack);
    if (res.headersSent) { return next(err); }
    if (err.message.includes("not allowed by CORS")) { return res.status(403).json({ error: "CORS_ERROR", message: err.message }); }
    res.status(err.status || 500).json({ error: "INTERNAL_SERVER_ERROR", message: err.message || 'An unexpected error occurred!' });
});

app.listen(PORT, () => { console.log(`Backend server running on port ${PORT}`); });