// backend/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./lib/prisma');

const app = express();
const PORT = process.env.PORT || 3001;

// --- CORS Configuration ---
const frontendUrlFromEnv = process.env.FRONTEND_URL;
// ... (Your full corsOptions setup - this part is likely fine)
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
app.use(cors(corsOptions));


// --- Conditional Body Parser ---
// This is the key change. We will use one body parser middleware,
// but it will behave differently based on the request path.
app.use((req, res, next) => {
    if (req.originalUrl === '/api/stripe/webhook') {
        // If the request is for our webhook, use the RAW body parser
        express.raw({ type: 'application/json' })(req, res, next);
    } else {
        // For all other requests, use the standard JSON parser
        express.json()(req, res, next);
    }
});


// --- Import Routers ---
const stripeRoutes = require('./routes/stripe'); // This will be simplified
const userRoutes = require('./routes/users');
const linkRoutes = require('./routes/links');
const publicProfileRoutes = require('./routes/publicProfile');
const { authMiddleware } = require('./middleware/auth');


// --- Mount Routers ---
// Routers are now mounted AFTER the conditional body parser.
app.use('/api/stripe', stripeRoutes);
app.use('/api/public', publicProfileRoutes);
app.use('/api/users', userRoutes);
app.use('/api/links', authMiddleware, (req, res, next) => {
    if (!req.localUser) {
        return res.status(403).json({ message: "User profile must be set up to manage links.", code: "PROFILE_REQUIRED_FOR_LINKS" });
    }
    next();
}, linkRoutes);


// ... (Health check and Error Handler remain the same as before) ...
app.get('/api', (req, res) => res.status(200).json({ status: 'healthy' }));
app.use((err, req, res, next) => { /* ... */ });
app.listen(PORT, () => { console.log(`Backend server running on port ${PORT}`); });