// File: backend/lib/prisma.js (This is your new, final version)

const { PrismaClient } = require('@prisma/client');

let prisma;

// This logic prevents creating new connections on every hot-reload in development
if (process.env.NODE_ENV === 'production') {
  prisma = new PrismaClient();
} else {
  if (!global.prisma) {
    global.prisma = new PrismaClient({
      // You can uncomment this for debugging database queries during development
      // log: ['query', 'info', 'warn', 'error'], 
    });
  }
  prisma = global.prisma;
}

// The key change is here: we export the 'prisma' instance directly.
module.exports = prisma;