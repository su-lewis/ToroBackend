// backend/routes/payments.js
const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');
const { subDays, startOfDay } = require('date-fns'); // npm install date-fns

// Helper function to abstract the database query for payment stats.
// This avoids repeating the same aggregation logic.
const getPaymentStats = async (userId, currency, dateFilter = {}) => {
  const stats = await prisma.payment.aggregate({
    where: {
      recipientUserId: userId,
      status: 'succeeded',
      currency: currency.toLowerCase(),
      ...dateFilter, // Spread the date filter if it exists
    },
    _sum: {
      netAmountToRecipient: true,
    },
    _count: {
      id: true,
    },
  });
  return {
    revenueCents: stats._sum.netAmountToRecipient || 0,
    giftCount: stats._count.id || 0,
  };
};
// GET /api/payments/stats - Fetch payment stats for the authenticated user
// Now accepts query parameters: ?period=7d¤cy=usd
router.get('/stats', authMiddleware, async (req, res) => {
  if (!req.localUser?.id) {
    return res.status(403).json({ message: 'User profile not found.' });
  }
  const userId = req.localUser.id;
  const period = req.query.period || '30d'; // Default to 30d if not provided
  const currency = req.query.currency || 'usd'; // Default to USD if not provided

  const now = new Date();

  // Use a map for a more declarative way to determine the start date.
  // This is easier to read and extend than a switch statement.
  const periodMap = {
    'today': () => startOfDay(now),
    '7d': () => subDays(now, 7),
    '30d': () => subDays(now, 30),
  };
  const startDate = (periodMap[period] || periodMap['30d'])();

  try {
    // Use the helper function to get both sets of stats
    const [periodStatsData, allTimeStatsData] = await Promise.all([
      getPaymentStats(userId, currency, { createdAt: { gte: startDate } }),
      getPaymentStats(userId, currency),
    ]);

    const stats = {
      allTime: {
        ...allTimeStatsData,
        currency: currency,
      },
      period: {
        ...periodStatsData,
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