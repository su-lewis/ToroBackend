// backend/lib/prisma.js
const { PrismaClient } = require('@prisma/client');

// This code prevents multiple instances of Prisma Client in development
// due to Next.js hot reloading. It's a standard best practice.
let prisma;

if (process.env.NODE_ENV === 'production') {
  // 1. In production, always create a new Prisma Client instance.
  prisma = new PrismaClient();
} else {
  // 2. In development, check if a Prisma Client instance already exists on the global object.
  if (!global.prisma) {
    // 3. If it doesn't exist, create a new one and attach it to the global object.
    global.prisma = new PrismaClient({
      // log: ['query'], // Uncomment for debugging database queries in your dev console
    });
  }
  // 4. Use the existing instance from the global object.
  prisma = global.prisma;
}

// 5. Export the single, managed Prisma Client instance.
// NOTE: We are exporting 'prisma' directly, not as an object `{ prisma }`.
module.exports = prisma;