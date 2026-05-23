const express = require('express');
const { SCRAPER_KEYS } = require('../lib/runTarget');

function createScrapersRouter() {
  const r = express.Router();

  r.get('/', (_req, res) => {
    res.json({ scrapers: SCRAPER_KEYS });
  });

  return r;
}

module.exports = { createScrapersRouter };

