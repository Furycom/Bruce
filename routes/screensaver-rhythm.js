/**
 * routes/screensaver-rhythm.js — S1461
 * Lightweight endpoint: rhythm metrics from screensaver logs.
 * Called by dashboard for real-time cycle speed, current job progress.
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');

const LOG_PATH = '/home/furycom/logs/screensaver.log';

router.get('/bruce/screensaver-rhythm', async (req, res) => {
  try {
    const log = fs.readFileSync(LOG_PATH, 'utf8');
    const lines = log.split('\n');

    // Parse heartbeats (last 10)
    const heartbeats = [];
    for (let i = lines.length - 1; i >= 0 && heartbeats.length < 10; i--) {
      const m = lines[i].match(/\[(\d{2}:\d{2}:\d{2})\].*Heartbeat.*cycles['":\s]*(\d+).*batches['":\s]*(\d+).*items_updated['":\s]*(\d+).*items_archived['":\s]*(\d+)/);
      if (m) heartbeats.unshift({ time: m[1], cycles: +m[2], batches: +m[3], updated: +m[4], archived: +m[5] });
    }

    // Current job from pipeline logs
    let currentJob = null, currentJobIndex = -1, totalJobs = 11;
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 100); i--) {
      const cm = lines[i].match(/\[PIPELINE\] stage=(\w+) index=(\d+)\/(\d+)/);
      if (cm) { currentJob = cm[1]; currentJobIndex = +cm[2]; totalJobs = +cm[3]; break; }
    }

    // Rhythm: cycles/hour, avg cycle duration
    let cyclesPerHour = null, avgCycleSec = null;
    if (heartbeats.length >= 2) {
      const last = heartbeats[heartbeats.length - 1], prev = heartbeats[heartbeats.length - 2];
      const [lh,lm,ls] = last.time.split(':').map(Number);
      const [ph,pm,ps] = prev.time.split(':').map(Number);
      let diffSec = (lh*3600+lm*60+ls) - (ph*3600+pm*60+ps);
      if (diffSec <= 0) diffSec += 86400;
      const dCycles = last.cycles - prev.cycles;
      if (diffSec > 0 && dCycles > 0) {
        cyclesPerHour = Math.round(dCycles / diffSec * 3600);
        avgCycleSec = Math.round(diffSec / dCycles);
      }
    }

    // Recent batch summaries (last 200 lines)
    const recentBatches = {};
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 200); i--) {
      const bm = lines[i].match(/\[(\w+)\] Batch summary: processed=(\d+) modified=(\d+) kept=(\d+) errored=(\d+)/);
      if (bm) {
        const job = bm[1];
        if (!recentBatches[job]) recentBatches[job] = { processed: 0, modified: 0, kept: 0, errored: 0, batches: 0 };
        recentBatches[job].processed += +bm[2]; recentBatches[job].modified += +bm[3];
        recentBatches[job].kept += +bm[4]; recentBatches[job].errored += +bm[5]; recentBatches[job].batches++;
      }
    }

    const latest = heartbeats.length > 0 ? heartbeats[heartbeats.length - 1] : {};

    res.json({
      ok: true,
      cyclesPerHour,
      avgCycleSec,
      totalCycles: latest.cycles || 0,
      totalUpdated: latest.updated || 0,
      totalArchived: latest.archived || 0,
      currentJob,
      currentJobIndex,
      totalJobs,
      recentBatches,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
