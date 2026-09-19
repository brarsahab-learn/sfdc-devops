/**
 * Per-org, per-object load tracking so re-running the seed loader only
 * (re)processes records that aren't already known-created in that org.
 *
 * Tracking file: <this-folder>/seed/.tracking/<org>.json
 *   { [sobject]: { [refId]: { status: 'created'|'failed', id, error, at } } }
 */
const fs = require('fs');
const path = require('path');

const TRACKING_DIR = path.join(__dirname, '..', 'seed', '.tracking');

function trackingPath(targetOrg) {
    const safeName = targetOrg.replace(/[^a-zA-Z0-9_.@-]/g, '_');
    return path.join(TRACKING_DIR, `${safeName}.json`);
}

function loadTracking(targetOrg) {
    const p = trackingPath(targetOrg);
    if (!fs.existsSync(p)) {
        return {};
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveTracking(targetOrg, tracking) {
    fs.mkdirSync(TRACKING_DIR, { recursive: true });
    fs.writeFileSync(trackingPath(targetOrg), JSON.stringify(tracking, null, 2));
}

module.exports = { loadTracking, saveTracking, trackingPath };
