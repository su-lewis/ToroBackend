// backend/lib/prisma.js
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  // log: ['query', 'info', 'warn', 'error'], // Uncomment for query logging during development
});

module.exports = prisma;