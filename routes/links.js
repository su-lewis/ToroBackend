// backend/routes/links.js
const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
// authMiddleware will be applied when this router is mounted in index.js

// Create a new link
router.post('/', async (req, res) => {
  if (!req.localUser) {
    return res.status(403).json({ message: "User profile not set up. Cannot create links." });
  }
  const { title, url } = req.body;
  if (!title || !url) {
    return res.status(400).json({ message: 'Title and URL are required' });
  }
  try {
    const newLink = await prisma.link.create({
      data: {
        title,
        url,
        userId: req.localUser.id, // localUser comes from authMiddleware
      },
    });
    res.status(201).json(newLink);
  } catch (error) {
    res.status(500).json({ message: 'Error creating link', error: error.message });
  }
});

// Get all links for the logged-in user
router.get('/', async (req, res) => {
  if (!req.localUser) {
    return res.status(403).json({ message: "User profile not set up." });
  }
  try {
    const links = await prisma.link.findMany({
      where: { userId: req.localUser.id },
      orderBy: { order: 'asc' }, // Or createdAt, etc.
    });
    res.json(links);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching links', error: error.message });
  }
});

// Update a link
router.put('/:linkId', async (req, res) => {
  if (!req.localUser) {
    return res.status(403).json({ message: "User profile not set up." });
  }
  const { linkId } = req.params;
  const { title, url, order } = req.body;
  try {
    const link = await prisma.link.findUnique({ where: { id: linkId } });
    if (!link || link.userId !== req.localUser.id) {
      return res.status(404).json({ message: 'Link not found or unauthorized' });
    }
    const updatedLink = await prisma.link.update({
      where: { id: linkId },
      data: { title, url, order },
    });
    res.json(updatedLink);
  } catch (error) {
    res.status(500).json({ message: 'Error updating link', error: error.message });
  }
});

// Delete a link
router.delete('/:linkId', async (req, res) => {
  if (!req.localUser) {
    return res.status(403).json({ message: "User profile not set up." });
  }
  const { linkId } = req.params;
  try {
    const link = await prisma.link.findUnique({ where: { id: linkId } });
    if (!link || link.userId !== req.localUser.id) {
      return res.status(404).json({ message: 'Link not found or unauthorized' });
    }
    await prisma.link.delete({ where: { id: linkId } });
    res.status(204).send(); // No content
  } catch (error) {
    res.status(500).json({ message: 'Error deleting link', error: error.message });
  }
});

module.exports = router;