// backend/routes/payments.js
const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');
const { subDays, startOfDay } = require('date-fns'); // npm install date-fns

// GET /api/payments/stats - Fetch payment stats for the authenticated user
// Now accepts query parameters: ?period=7d¤cy=usd
router.get('/stats', authMiddleware, async (req, res) => {
  if (!req.localUser?.id) {
    return res.status(403).json({ message: 'User profile not found.' });
  }
  const userId = req.localUser.id;
  const period = req.query.period || '30d'; // Default to 30d if not provided
  const currency = req.query.currency || 'usd'; // Default to USD if not provided

  let startDate;
  const now = new Date();

  // Determine the start date based on the requested period
  switch (period) {
    case 'today':
      startDate = startOfDay(now);
      break;
    case '7d':
      startDate = subDays(now, 7);
      break;
    case '30d':
    default:
      startDate = subDays(now, 30);
      break;
  }

  try {
    // 1. Calculate stats for the requested period, filtered by currency
    const periodStats = await prisma.payment.aggregate({
      where: {
        recipientUserId: userId,
        status: 'succeeded',
        currency: currency.toLowerCase(), // Filter by the user's primary currency
        createdAt: {
          gte: startDate, // gte = greater than or equal to
        },
      },
      _sum: {
        netAmountToRecipient: true, // Sum of what the creator received (in cents)
      },
      _count: {
        id: true, // Count of successful payments
      },
    });

    // 2. Calculate All-Time stats, also filtered by the same currency
    const allTimeStats = await prisma.payment.aggregate({
      where: { recipientUserId: userId, status: 'succeeded', currency: currency.toLowerCase() },
      _sum: {
        netAmountToRecipient: true,
      },
      _count: {
        id: true,
      },
    });

    const stats = {
      allTime: {
        revenueCents: allTimeStats._sum.netAmountToRecipient || 0,
        giftCount: allTimeStats._count.id || 0,
        currency: currency,
      },
      period: {
        revenueCents: periodStats._sum.netAmountToRecipient || 0,
        giftCount: periodStats._count.id || 0,
        currency: currency,
        timeframe: period, // e.g., '7d', '30d', 'today'
      },
    };

    res.json(stats);

  } catch (error) {
    console.error(`[/api/payments/stats] Error fetching payment stats for user ${userId}:`, error);
    res.status(500).json({ message: 'Failed to fetch payment stats.' });
  }
});

// GET /api/payments/history - Fetch detailed payment history for the authenticated user
router.get('/history', authMiddleware, async (req, res) => {
    if (!req.localUser?.id) {
      return res.status(403).json({ message: 'User profile not found.' });
    }
    const userId = req.localUser.id;
  
    try {
      const paymentHistory = await prisma.payment.findMany({
        where: { recipientUserId: userId, status: 'succeeded' },
        orderBy: {
          createdAt: 'desc', // Show most recent first
        },
        select: {
          id: true,
          createdAt: true,
          netAmountToRecipient: true,
          currency: true,
          payerName: true,
        },
        take: 50, // Limit to the last 50 payments for performance
      });
  
      res.json(paymentHistory);
  
    } catch (error) {
      console.error(`[/api/payments/history] Error fetching payment history for user ${userId}:`, error);
      res.status(500).json({ message: 'Failed to fetch payment history.' });
    }
});


module.exports = router;