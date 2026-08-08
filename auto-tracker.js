const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const LOG_FILE_PATH = path.join(__dirname, 'progress_log.txt');

function recordProgress() {
    try {
        // Automatically fetches the latest Git commit message and timestamp
        const commitMsg = execSync('git log -1 --pretty=%B').toString().trim();
        const timestamp = new Date().toISOString();
        
        // Detects step and status based on commit keywords (e.g., 'fix:', 'test:', 'upgrade:')
        let step = 'UPDATE';
        let status = 'SUCCESS';
        
        if (commitMsg.toLowerCase().includes('test')) step = 'TEST';
        if (commitMsg.toLowerCase().includes('fix')) { step = 'FIX_ERROR'; }
        if (commitMsg.toLowerCase().includes('upgrade') || commitMsg.toLowerCase().includes('feat')) step = 'UPGRADE';

        const logEntry = `[${timestamp}] | STEP: ${step} | STATUS: ${status} | DETAILS: ${commitMsg}\n`;

        fs.appendFileSync(LOG_FILE_PATH, logEntry);
        console.log(`🤖 Auto-Tracker logged: [${step}] ${commitMsg}`);
    } catch (error) {
        console.error('Auto-tracker background error:', error.message);
    }
}

recordProgress();
